import { randomUUID } from 'node:crypto';
import type { AlertEvaluation, LlmModelProvider } from '@miniapp/shared';
import { createLogger, type Logger } from '../../lib/logger.js';
import { config } from '../../platform/config.js';
import { AlertPublisher, type AlertPublishResult } from '../alerting/publisher.js';
import { PrismaAlertPersistence } from '../alerting/repository.js';

export type ProviderAlertClass = 'rate_limited' | 'quota_exhausted' | 'access_blocked';

type Publisher = {
  publish(input: unknown, options?: { notify?: boolean }): Promise<AlertPublishResult>;
};

type IncidentState = {
  active: boolean;
  targetActive: boolean;
  processing: boolean;
  nextAttemptAt: number;
  status: number;
  model: string;
};

export type ProviderResponseObservation = {
  provider: LlmModelProvider;
  model: string;
  status: number;
};

const RETRY_COOLDOWN_MS = 60_000;

export function classifyProviderAlert(status: number): ProviderAlertClass | null {
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota_exhausted';
  if (status === 401 || status === 403) return 'access_blocked';
  return null;
}

/**
 * Coalesces request-level provider responses into incident transitions. Publishing is deliberately
 * detached from generation: database or Feishu failures must never delay SSE, fallback, or billing.
 */
export class LlmProviderAlertObserver {
  private readonly incidents = new Map<string, IncidentState>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly publisher: Publisher,
    private readonly log: Pick<Logger, 'biz' | 'sys'>,
    private readonly options: {
      now?: () => number;
      environment?: AlertEvaluation['environment'];
      retryCooldownMs?: number;
    } = {}
  ) {}

  observe(input: ProviderResponseObservation): void {
    const alertClass = classifyProviderAlert(input.status);
    if (alertClass) {
      const identity = incidentIdentity(input, alertClass);
      const state = this.incidents.get(identity.key) ?? {
        active: false,
        targetActive: false,
        processing: false,
        nextAttemptAt: 0,
        status: input.status,
        model: identity.model,
      };
      state.targetActive = true;
      state.status = input.status;
      state.model = identity.model;
      this.incidents.set(identity.key, state);
      this.drive(identity.key, input.provider, alertClass, state);
      return;
    }

    if (input.status < 200 || input.status >= 300) return;
    for (const [key, state] of this.incidents) {
      const identity = parseIncidentKey(key);
      if (
        identity.provider !== input.provider ||
        (identity.alertClass === 'rate_limited' && state.model !== safeModel(input.model))
      )
        continue;
      state.targetActive = false;
      state.status = input.status;
      this.drive(key, identity.provider, identity.alertClass, state);
    }
  }

  /** Test/controlled-shutdown hook; request paths never await this. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private drive(
    key: string,
    provider: LlmModelProvider,
    alertClass: ProviderAlertClass,
    state: IncidentState
  ): void {
    if (state.processing || state.active === state.targetActive || this.now() < state.nextAttemptAt)
      return;
    state.processing = true;
    const work = this.publishTransitions(key, provider, alertClass, state).finally(() => {
      state.processing = false;
      this.pending.delete(work);
      if (state.active !== state.targetActive && this.now() >= state.nextAttemptAt) {
        this.drive(key, provider, alertClass, state);
      }
    });
    this.pending.add(work);
  }

  private async publishTransitions(
    key: string,
    provider: LlmModelProvider,
    alertClass: ProviderAlertClass,
    state: IncidentState
  ): Promise<void> {
    while (state.active !== state.targetActive) {
      const targetActive = state.targetActive;
      try {
        const result = await this.publisher.publish(
          createProviderEvaluation({
            provider,
            model: state.model,
            status: state.status,
            alertClass,
            firing: targetActive,
            now: new Date(this.now()),
            environment: this.environment(),
          }),
          { notify: true }
        );
        if (result.kind === 'failed') {
          state.nextAttemptAt = this.now() + this.retryCooldownMs();
          this.log.sys.warn(
            {
              event: 'llm.provider_alert.publish_failed',
              provider,
              alertClass,
              result: result.reason,
            },
            '模型供应商告警发布失败；等待后续响应重试'
          );
          return;
        }
        state.active = targetActive;
        state.nextAttemptAt = 0;
        this.log.biz.info(
          {
            event: 'llm.provider_alert.transition',
            provider,
            alertClass,
            state: targetActive ? 'firing' : 'healthy',
            result: result.kind,
          },
          '模型供应商告警状态已更新'
        );
      } catch (err) {
        state.nextAttemptAt = this.now() + this.retryCooldownMs();
        this.log.sys.warn(
          { event: 'llm.provider_alert.publish_failed', err, provider, alertClass },
          '模型供应商告警发布异常；等待后续响应重试'
        );
        return;
      }
    }
    if (!state.active && !state.targetActive && this.incidents.get(key) === state) {
      this.incidents.delete(key);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private environment(): AlertEvaluation['environment'] {
    if (this.options.environment) return this.options.environment;
    if (
      config.nodeEnv === 'production' ||
      config.nodeEnv === 'test' ||
      config.nodeEnv === 'preview'
    )
      return config.nodeEnv;
    return 'development';
  }

  private retryCooldownMs(): number {
    return this.options.retryCooldownMs ?? RETRY_COOLDOWN_MS;
  }
}

function incidentIdentity(input: ProviderResponseObservation, alertClass: ProviderAlertClass) {
  const model = safeModel(input.model);
  return {
    model,
    key:
      alertClass === 'rate_limited'
        ? `${input.provider}:${alertClass}:${model}`
        : `${input.provider}:${alertClass}`,
  };
}

function parseIncidentKey(key: string): {
  provider: LlmModelProvider;
  alertClass: ProviderAlertClass;
} {
  const [provider, alertClass] = key.split(':');
  return {
    provider: provider === 'venice' ? 'venice' : 'openrouter',
    alertClass: alertClass as ProviderAlertClass,
  };
}

function safeModel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  return normalized && !/[a-f0-9]{32,}/i.test(normalized) ? normalized : 'unknown';
}

function createProviderEvaluation(input: {
  provider: LlmModelProvider;
  model: string;
  status: number;
  alertClass: ProviderAlertClass;
  firing: boolean;
  now: Date;
  environment: AlertEvaluation['environment'];
}): AlertEvaluation {
  const at = input.now.toISOString();
  const definition = alertDefinition(input.provider, input.alertClass);
  const modelIdentity =
    input.alertClass === 'rate_limited' ? `:${fingerprintModel(input.model)}` : '';
  return {
    schema_version: 1,
    evaluation_id: randomUUID(),
    producer_run_id: randomUUID(),
    domain: 'generation',
    service: 'llm_generation',
    environment: input.environment,
    rule_id: `provider-${input.alertClass.replaceAll('_', '-')}`,
    rule_version: '1',
    rule_group: `provider-${input.alertClass.replaceAll('_', '-')}`,
    fingerprint: `${input.environment}:generation:${input.provider}:${input.alertClass}${modelIdentity}`,
    state: input.firing ? 'firing' : 'healthy',
    severity: definition.severity,
    location: { kind: 'dependency', component: input.provider },
    confidence: 'confirmed',
    observed_at: at,
    window_started_at: at,
    window_ended_at: at,
    title: definition.title,
    summary: input.firing
      ? `${input.provider} 模型调用返回 HTTP ${input.status}，错误类别为 ${input.alertClass}。`
      : `${input.provider} 已重新返回成功响应，本次 ${input.alertClass} 事故恢复。`,
    metrics: [
      { name: 'upstream_status', value: input.status },
      { name: 'observed_events', value: 1, unit: 'count' },
    ],
    samples: [{ kind: 'model', reference: input.model }],
    recommended_action: definition.action,
  };
}

function fingerprintModel(model: string): string {
  return (
    model
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64) || 'unknown'
  );
}

function alertDefinition(
  provider: LlmModelProvider,
  alertClass: ProviderAlertClass
): { severity: AlertEvaluation['severity']; title: string; action: string } {
  if (alertClass === 'rate_limited') {
    return {
      severity: 'P1',
      title: `P1 ${provider} 模型调用被限流或过载`,
      action: '检查供应商限流面板、模型容量和请求突增；不要对非幂等生成做无界重试。',
    };
  }
  if (alertClass === 'quota_exhausted') {
    return {
      severity: 'P0',
      title: `P0 ${provider} 模型额度或消费上限不足`,
      action: '检查供应商账户余额、API key 消费上限和自动充值状态，恢复后用测试请求验证。',
    };
  }
  return {
    severity: 'P0',
    title: `P0 ${provider} 模型凭据或账户访问受阻`,
    action: '检查对应环境的 API key 是否有效、账户是否禁用及模型访问权限；不要在日志中打印密钥。',
  };
}

const providerAlertLog = createLogger('llm-provider-alerts');
const providerAlertObserver = new LlmProviderAlertObserver(
  new AlertPublisher(new PrismaAlertPersistence(), providerAlertLog),
  providerAlertLog
);

/** Response headers are enough for safe classification; never consume the provider error body. */
export function observeLlmProviderResponse(input: ProviderResponseObservation): void {
  providerAlertObserver.observe(input);
}
