import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AlertEvaluation } from '@miniapp/shared';
import type { Logger } from '../../lib/logger.js';
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';
import type { AlertPublisher } from '../alerting/publisher.js';

/** Keep the provider balance policy aligned with the existing Venice early warning. */
export const SURPLUS_USD_BALANCE_THRESHOLD = 10;
export const SURPLUS_BALANCE_LOW_RULE_ID = 'surplus-balance-low';
export const SURPLUS_BALANCE_RULE_VERSION = '1';
export const SURPLUS_BALANCE_RECOVERY_PASSES = 2;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_ATTEMPTS = 2;

export type SurplusUsdBalanceSnapshot = { usd: number };

export type SurplusBalanceProbeResult =
  | { kind: 'ok'; snapshot: SurplusUsdBalanceSnapshot }
  | { kind: 'skipped'; reason: 'missing_api_key' }
  | { kind: 'probe_failed'; reason: 'auth_failed' | 'timeout' | 'upstream' | 'invalid_body' };

type Publisher = Pick<AlertPublisher, 'publish'>;

/** Surplus Intelligence exposes spendable credit as an integer-microdollar string. */
export function parseSurplusUsdBalance(body: unknown): SurplusUsdBalanceSnapshot | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const rawMicroUsd = record.credit_balance_usdc;
  if (typeof rawMicroUsd !== 'string' || !/^(?:0|[1-9]\d*)$/.test(rawMicroUsd)) return null;
  const usd = Number(rawMicroUsd) / 1_000_000;
  return Number.isFinite(usd) && usd >= 0 ? { usd } : null;
}

export function isSurplusUsdBalanceLow(
  usd: number,
  threshold = SURPLUS_USD_BALANCE_THRESHOLD
): boolean {
  return usd < threshold;
}

export function buildSurplusBalanceEvaluation(input: {
  usd: number;
  firing: boolean;
  now: Date;
  environment?: AlertEvaluation['environment'];
  threshold?: number;
}): AlertEvaluation {
  const threshold = input.threshold ?? SURPLUS_USD_BALANCE_THRESHOLD;
  const environment = input.environment ?? alertEnvironment();
  const at = input.now.toISOString();
  return {
    schema_version: 1,
    evaluation_id: randomUUID(),
    producer_run_id: randomUUID(),
    domain: 'generation',
    service: 'llm_generation',
    environment,
    rule_id: SURPLUS_BALANCE_LOW_RULE_ID,
    rule_version: SURPLUS_BALANCE_RULE_VERSION,
    rule_group: SURPLUS_BALANCE_LOW_RULE_ID,
    fingerprint: `${environment}:generation:surplus:balance_low`,
    state: input.firing ? 'firing' : 'healthy',
    severity: 'P1',
    location: { kind: 'dependency', component: 'surplus' },
    confidence: 'confirmed',
    observed_at: at,
    window_started_at: at,
    window_ended_at: at,
    title: input.firing
      ? 'P1 Surplus Intelligence USD 余额低于阈值'
      : 'P1 Surplus Intelligence USD 余额已恢复',
    summary: input.firing
      ? `Surplus Intelligence 可消费余额约为 ${formatUsd(input.usd)}，低于阈值 $${threshold}。`
      : `Surplus Intelligence 可消费余额约为 ${formatUsd(input.usd)}，已不低于阈值 $${threshold}。`,
    metrics: [
      { name: 'balance_usd_cents', value: Math.round(input.usd * 100), unit: 'count' },
      { name: 'threshold_usd_cents', value: Math.round(threshold * 100), unit: 'count' },
    ],
    samples: [{ kind: 'provider', reference: 'surplus' }],
    recommended_action:
      '在 Surplus Intelligence 账户补充可消费余额；恢复后用 GET /payments/balance 复核，勿在日志中打印 API key、余额字段或原始响应。',
  };
}

/** Probe the documented balance endpoint with bounded retry; never return the raw body. */
export async function probeSurplusUsdBalance(
  options: {
    fetchImpl?: typeof fetch;
    apiKey?: string;
    baseUrl?: string;
    timeoutMs?: number;
    attempts?: number;
  } = {}
): Promise<SurplusBalanceProbeResult> {
  const runtime = getLlmProviderRuntimeConfig('surplus');
  const apiKey = options.apiKey ?? runtime.apiKey;
  const baseUrl = (options.baseUrl ?? runtime.baseUrl).replace(/\/+$/, '');
  if (!apiKey) return { kind: 'skipped', reason: 'missing_api_key' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const attempts = options.attempts ?? PROBE_ATTEMPTS;
  let lastFailure: SurplusBalanceProbeResult = { kind: 'probe_failed', reason: 'upstream' };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/payments/balance`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        return { kind: 'probe_failed', reason: 'auth_failed' };
      }
      if (response.status >= 500) {
        lastFailure = { kind: 'probe_failed', reason: 'upstream' };
        if (attempt + 1 < attempts) await sleep(100 * (attempt + 1));
        continue;
      }
      if (!response.ok) return { kind: 'probe_failed', reason: 'upstream' };
      const snapshot = parseSurplusUsdBalance(await response.json());
      return snapshot ? { kind: 'ok', snapshot } : { kind: 'probe_failed', reason: 'invalid_body' };
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      lastFailure = { kind: 'probe_failed', reason: timedOut ? 'timeout' : 'upstream' };
      if (attempt + 1 < attempts) await sleep(100 * (attempt + 1));
    }
  }
  return lastFailure;
}

/** Probe failures never emit healthy and therefore cannot clear an active incident. */
export class SurplusBalanceMonitor {
  private healthyPasses = 0;

  constructor(
    private readonly publisher: Publisher,
    private readonly log: Pick<Logger, 'biz' | 'sys'>,
    private readonly probe: () => Promise<SurplusBalanceProbeResult> = probeSurplusUsdBalance
  ) {}

  async runOnce(now = new Date()): Promise<{
    published: number;
    outcome: 'ok' | 'skipped' | 'probe_failed';
  }> {
    const result = await this.probe();
    if (result.kind !== 'ok') {
      this.healthyPasses = 0;
      const log =
        result.kind === 'skipped'
          ? this.log.biz.info.bind(this.log.biz)
          : this.log.sys.warn.bind(this.log.sys);
      log(
        { event: `surplus.balance_monitor.${result.kind}`, reason: result.reason },
        result.kind === 'skipped'
          ? 'Surplus 余额检查已跳过'
          : 'Surplus 余额探针失败；不发布 healthy、不关闭既有事故'
      );
      return { published: 0, outcome: result.kind };
    }

    const firing = isSurplusUsdBalanceLow(result.snapshot.usd);
    if (firing) this.healthyPasses = 0;
    else this.healthyPasses += 1;

    if (!firing && this.healthyPasses < SURPLUS_BALANCE_RECOVERY_PASSES) {
      this.logHeartbeat(result.snapshot.usd, 'healthy_pending', 0);
      return { published: 0, outcome: 'ok' };
    }

    const evaluation = buildSurplusBalanceEvaluation({
      usd: result.snapshot.usd,
      firing,
      now,
    });
    const publishResult = await this.publisher.publish(evaluation, { notify: true });
    const published = publishResult.kind === 'accepted' ? 1 : 0;
    this.logHeartbeat(result.snapshot.usd, firing ? 'firing' : 'healthy', published);
    return { published, outcome: 'ok' };
  }

  private logHeartbeat(usd: number, state: string, published: number): void {
    this.log.biz.info(
      {
        event: 'surplus.balance_monitor.heartbeat',
        outcome: 'ok',
        state,
        published,
        balanceUsdCents: Math.round(usd * 100),
        ...(state === 'healthy_pending' ? { healthyPasses: this.healthyPasses } : {}),
      },
      'Surplus 余额监控轮次完成'
    );
  }
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function alertEnvironment(): AlertEvaluation['environment'] {
  const environment = process.env.NODE_ENV;
  return environment === 'production' || environment === 'test' || environment === 'preview'
    ? environment
    : 'development';
}
