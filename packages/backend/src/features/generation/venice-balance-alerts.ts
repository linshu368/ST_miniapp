import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AlertEvaluation } from '@miniapp/shared';
import type { Logger } from '../../lib/logger.js';
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';
import { veniceFetch } from '../../platform/venice-http.js';
import type { AlertPublisher } from '../alerting/publisher.js';

/** USD prepaid balance below this value triggers a P1 early-warning alert. */
export const VENICE_USD_BALANCE_THRESHOLD = 10;
export const VENICE_BALANCE_LOW_RULE_ID = 'venice-balance-low';
export const VENICE_BALANCE_RULE_VERSION = '1';
export const VENICE_BALANCE_RECOVERY_PASSES = 2;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_ATTEMPTS = 2;

export type VeniceUsdBalanceSnapshot = {
  usd: number;
  canConsume: boolean | null;
};

export type VeniceBalanceProbeResult =
  | { kind: 'ok'; snapshot: VeniceUsdBalanceSnapshot }
  | { kind: 'skipped'; reason: 'missing_api_key' }
  | { kind: 'probe_failed'; reason: 'auth_failed' | 'timeout' | 'upstream' | 'invalid_body' };

type Publisher = Pick<AlertPublisher, 'publish'>;

/**
 * Reads only balances.usd (null → 0). Other credit types are intentionally ignored for the $10 rule.
 */
export function parseVeniceUsdBalance(body: unknown): VeniceUsdBalanceSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const balances = (body as { balances?: unknown }).balances;
  if (!balances || typeof balances !== 'object') return null;
  const rawUsd = (balances as { usd?: unknown }).usd;
  const usd = rawUsd === null || rawUsd === undefined ? 0 : rawUsd;
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
  const canConsumeRaw = (body as { canConsume?: unknown }).canConsume;
  const canConsume = typeof canConsumeRaw === 'boolean' ? canConsumeRaw : null;
  return { usd, canConsume };
}

export function isVeniceUsdBalanceLow(
  usd: number,
  threshold = VENICE_USD_BALANCE_THRESHOLD
): boolean {
  return usd < threshold;
}

export function buildVeniceBalanceEvaluation(input: {
  usd: number;
  canConsume: boolean | null;
  firing: boolean;
  now: Date;
  environment?: AlertEvaluation['environment'];
  threshold?: number;
}): AlertEvaluation {
  const threshold = input.threshold ?? VENICE_USD_BALANCE_THRESHOLD;
  const environment = input.environment ?? alertEnvironment();
  const at = input.now.toISOString();
  const cents = Math.round(input.usd * 100);
  const canConsumeText =
    input.canConsume === null ? 'unknown' : input.canConsume ? 'true' : 'false';
  return {
    schema_version: 1,
    evaluation_id: randomUUID(),
    producer_run_id: randomUUID(),
    domain: 'generation',
    service: 'llm_generation',
    environment,
    rule_id: VENICE_BALANCE_LOW_RULE_ID,
    rule_version: VENICE_BALANCE_RULE_VERSION,
    rule_group: VENICE_BALANCE_LOW_RULE_ID,
    fingerprint: `${environment}:generation:venice:balance_low`,
    state: input.firing ? 'firing' : 'healthy',
    severity: 'P1',
    location: { kind: 'dependency', component: 'venice' },
    confidence: 'confirmed',
    observed_at: at,
    window_started_at: at,
    window_ended_at: at,
    title: input.firing ? 'P1 Venice USD 余额低于阈值' : 'P1 Venice USD 余额已恢复到阈值及以上',
    summary: input.firing
      ? `Venice balances.usd 约为 ${formatUsd(input.usd)}，低于阈值 $${threshold}（canConsume=${canConsumeText}）。`
      : `Venice balances.usd 约为 ${formatUsd(input.usd)}，已不低于阈值 $${threshold}。`,
    metrics: [
      { name: 'balance_usd_cents', value: cents, unit: 'count' },
      { name: 'threshold_usd_cents', value: Math.round(threshold * 100), unit: 'count' },
    ],
    samples: [{ kind: 'provider', reference: 'venice' }],
    recommended_action:
      '在 Venice 控制台为该 Admin 账户充值 USD；恢复后可用 billing/balance 复核，勿在日志中打印 API key。',
  };
}

/** Probe Venice billing balance with bounded timeout and retries. Never returns the raw body. */
export async function probeVeniceUsdBalance(
  options: {
    fetchImpl?: typeof veniceFetch;
    apiKey?: string;
    baseUrl?: string;
    timeoutMs?: number;
    attempts?: number;
  } = {}
): Promise<VeniceBalanceProbeResult> {
  const runtime = getLlmProviderRuntimeConfig('venice');
  const apiKey = options.apiKey ?? runtime.apiKey;
  const baseUrl = (options.baseUrl ?? runtime.baseUrl).replace(/\/$/, '');
  if (!apiKey) return { kind: 'skipped', reason: 'missing_api_key' };

  const fetchImpl = options.fetchImpl ?? veniceFetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const attempts = options.attempts ?? PROBE_ATTEMPTS;
  let lastFailure: VeniceBalanceProbeResult = {
    kind: 'probe_failed',
    reason: 'upstream',
  };

  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/billing/balance`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        return { kind: 'probe_failed', reason: 'auth_failed' };
      }
      if (response.status >= 500) {
        lastFailure = { kind: 'probe_failed', reason: 'upstream' };
        if (i + 1 < attempts) await sleep(100 * (i + 1));
        continue;
      }
      if (!response.ok) {
        return { kind: 'probe_failed', reason: 'upstream' };
      }
      const body: unknown = await response.json();
      const snapshot = parseVeniceUsdBalance(body);
      if (!snapshot) return { kind: 'probe_failed', reason: 'invalid_body' };
      return { kind: 'ok', snapshot };
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      lastFailure = { kind: 'probe_failed', reason: timedOut ? 'timeout' : 'upstream' };
      if (i + 1 < attempts) await sleep(100 * (i + 1));
    }
  }
  return lastFailure;
}

/**
 * Publishes Venice USD low-balance evaluations into the shared alert outbox.
 * Probe failures never emit healthy and never clear an active balance_low incident.
 */
export class VeniceBalanceMonitor {
  private healthyPasses = 0;

  constructor(
    private readonly publisher: Publisher,
    private readonly log: Pick<Logger, 'biz' | 'sys'>,
    private readonly probe: () => Promise<VeniceBalanceProbeResult> = probeVeniceUsdBalance
  ) {}

  async runOnce(now = new Date()): Promise<{
    published: number;
    outcome: 'ok' | 'skipped' | 'probe_failed';
  }> {
    const result = await this.probe();
    if (result.kind === 'skipped') {
      this.log.biz.info(
        { event: 'venice.balance_monitor.skipped', reason: result.reason },
        'Venice 余额检查已跳过'
      );
      return { published: 0, outcome: 'skipped' };
    }
    if (result.kind === 'probe_failed') {
      this.log.sys.warn(
        { event: 'venice.balance_monitor.probe_failed', reason: result.reason },
        'Venice 余额探针失败；不发布 healthy、不关闭既有事故'
      );
      return { published: 0, outcome: 'probe_failed' };
    }

    const firing = isVeniceUsdBalanceLow(result.snapshot.usd);
    if (firing) {
      this.healthyPasses = 0;
      const evaluation = buildVeniceBalanceEvaluation({
        usd: result.snapshot.usd,
        canConsume: result.snapshot.canConsume,
        firing: true,
        now,
      });
      const publishResult = await this.publisher.publish(evaluation, { notify: true });
      const published = publishResult.kind === 'accepted' ? 1 : 0;
      this.log.biz.info(
        {
          event: 'venice.balance_monitor.heartbeat',
          outcome: 'ok',
          state: 'firing',
          published,
          balanceUsdCents: Math.round(result.snapshot.usd * 100),
        },
        'Venice 余额监控轮次完成'
      );
      return { published, outcome: 'ok' };
    }

    this.healthyPasses += 1;
    if (this.healthyPasses < VENICE_BALANCE_RECOVERY_PASSES) {
      this.log.biz.info(
        {
          event: 'venice.balance_monitor.heartbeat',
          outcome: 'ok',
          state: 'healthy_pending',
          healthyPasses: this.healthyPasses,
          published: 0,
          balanceUsdCents: Math.round(result.snapshot.usd * 100),
        },
        'Venice 余额监控轮次完成'
      );
      return { published: 0, outcome: 'ok' };
    }

    const evaluation = buildVeniceBalanceEvaluation({
      usd: result.snapshot.usd,
      canConsume: result.snapshot.canConsume,
      firing: false,
      now,
    });
    const publishResult = await this.publisher.publish(evaluation, { notify: true });
    const published = publishResult.kind === 'accepted' ? 1 : 0;
    this.log.biz.info(
      {
        event: 'venice.balance_monitor.heartbeat',
        outcome: 'ok',
        state: 'healthy',
        published,
        balanceUsdCents: Math.round(result.snapshot.usd * 100),
      },
      'Venice 余额监控轮次完成'
    );
    return { published, outcome: 'ok' };
  }
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function alertEnvironment(): AlertEvaluation['environment'] {
  const e = process.env.NODE_ENV;
  return e === 'production' || e === 'test' || e === 'preview' ? e : 'development';
}
