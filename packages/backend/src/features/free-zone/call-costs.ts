/**
 * 畅聊上游调用的花费核算任务：每 10 分钟给还没定花费的调用补上真实花费。
 *
 * - Surplus 主请求：拉账单明细，按请求号对上；没请求号的按「模型 + 结算时间」配（见 call-cost-plan）。
 *   配对必须在拿到锁的事务里做：多副本同时配会把同一条账单配给两次调用。
 * - OpenRouter 兜底：按生成编号查用量。被取消/超时又查不到的，写入估算值（近 7 天同类兜底的
 *   平均花费，每 6 小时算一次，不求精确）；一发出就报错、没有生成编号的按 0。
 * 外部接口拿不到就本轮跳过，下一轮再补；过了期限仍拿不到才记为查不到。
 */
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/db.js';
import { observeBackgroundRun } from '../../lib/background-observability.js';
import { runObservedJob } from '../../platform/observability/jobs.js';
import { fetchGenerationData, type GenerationData } from '../generation/openrouter-metadata.js';
import {
  GIVE_UP_MS,
  SETTLE_AFTER_MS,
  planSurplusCosts,
  type PendingSurplusCall,
  type SurplusCostDecision,
} from './call-cost-plan.js';
import { fetchSurplusUsage, type SurplusUsageRow } from './surplus-usage-export.js';

const JOB = 'free_zone_call_costs';
const INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const ADVISORY_LOCK_KEY = 740_116;
const BATCH = 2000;
const OPENROUTER_PER_RUN = 60;
const OPENROUTER_MAX_ATTEMPTS = 8;
const ESTIMATE_REFRESH_MS = 6 * 60 * 60 * 1000;
const MIN_ESTIMATE_SAMPLES = 5;
const STOPPED_REASONS = ['cancelled', 'first_token_deadline'];

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let running = false;
let estimateCache: { usd: string; at: number } | null = null;

interface PendingRow {
  id: string;
  provider: string;
  provider_model: string;
  dispatched_at: Date;
  end_reason: string;
  request_id: string | null;
  generation_id: string | null;
  cost_attempts: number;
}

export interface CallCostDeps {
  fetchUsage(from: Date, to: Date): Promise<SurplusUsageRow[]>;
  fetchGeneration(id: string): Promise<GenerationData | null>;
  now(): number;
}

const defaultDeps: CallCostDeps = {
  fetchUsage: fetchSurplusUsage,
  fetchGeneration: fetchGenerationData,
  now: () => Date.now(),
};

async function loadPending(provider: 'surplus' | 'openrouter' | 'other', now: number) {
  const before = new Date(now - SETTLE_AFTER_MS);
  const rows = await prisma.$queryRaw<PendingRow[]>`
    SELECT id::text, provider, provider_model, dispatched_at, end_reason, request_id, generation_id,
      cost_attempts
    FROM miniapp_features.free_zone_calls
    WHERE cost_source IS NULL AND dispatched_at < ${before}
      AND CASE WHEN ${provider} = 'other' THEN provider NOT IN ('surplus', 'openrouter')
               ELSE provider = ${provider} END
    ORDER BY dispatched_at
    LIMIT ${BATCH}`;
  return rows;
}

async function markUnavailable(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await prisma.$executeRaw`
    UPDATE miniapp_features.free_zone_calls
    SET cost_source = 'unavailable', settled_at = now()
    WHERE id = ANY(${ids}::uuid[]) AND cost_source IS NULL`;
}

async function saveCosts(
  client: Pick<typeof prisma, '$executeRaw'>,
  settled: Array<{
    id: string;
    source: string;
    costUsd: string;
    requestId: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
  }>
): Promise<void> {
  if (!settled.length) return;
  const text = (value: number | null) => (value === null ? '' : String(value));
  await client.$executeRaw`
    UPDATE miniapp_features.free_zone_calls c
    SET cost_usd = u.cost::numeric, cost_source = u.source,
      request_id = COALESCE(c.request_id, NULLIF(u.request_id, '')),
      prompt_tokens = NULLIF(u.prompt, '')::bigint,
      completion_tokens = NULLIF(u.completion, '')::bigint,
      settled_at = now()
    FROM unnest(
      ${settled.map((item) => item.id)}::uuid[], ${settled.map((item) => item.source)}::text[],
      ${settled.map((item) => item.costUsd)}::text[],
      ${settled.map((item) => item.requestId ?? '')}::text[],
      ${settled.map((item) => text(item.promptTokens))}::text[],
      ${settled.map((item) => text(item.completionTokens))}::text[]
    ) AS u(id, source, cost, request_id, prompt, completion)
    WHERE c.id = u.id AND c.cost_source IS NULL`;
}

/** Surplus：账单在锁外拉；配对和写入在锁内，按锁内重读的待核算行和已知请求号算 */
async function settleSurplus(deps: CallCostDeps): Promise<number> {
  const now = deps.now();
  const snapshot = await loadPending('surplus', now);
  if (!snapshot.length) return 0;
  const from = new Date(snapshot[0]!.dispatched_at.getTime() - 60_000);
  const usage = await deps.fetchUsage(from, new Date(now));
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked`;
      if (!lock?.locked) return 0;
      const pending = await tx.$queryRaw<PendingRow[]>`
        SELECT id::text, provider, provider_model, dispatched_at, end_reason, request_id, generation_id,
      cost_attempts
        FROM miniapp_features.free_zone_calls
        WHERE cost_source IS NULL AND provider = 'surplus' AND id = ANY(${snapshot.map((row) => row.id)}::uuid[])`;
      const since = new Date(from.getTime() - 60 * 60 * 1000);
      const known = await tx.$queryRaw<Array<{ request_id: string }>>`
        SELECT request_id FROM miniapp_features.free_zone_calls
        WHERE request_id IS NOT NULL AND dispatched_at >= ${since}
        UNION
        SELECT request_id FROM experience.surplusintelligence_chat_history
        WHERE request_id IS NOT NULL AND created_at >= ${since}`;
      const decisions = planSurplusCosts({
        pending: pending.map(
          (row): PendingSurplusCall => ({
            id: row.id,
            providerModel: row.provider_model,
            dispatchedAt: row.dispatched_at.getTime(),
            requestId: row.request_id,
          })
        ),
        usage,
        knownRequestIds: new Set(known.map((row) => row.request_id)),
        now,
      });
      const settled = decisions.filter(
        (item): item is Extract<SurplusCostDecision, { costUsd: string }> =>
          item.source !== 'unavailable'
      );
      await saveCosts(tx, settled);
      const unavailable = decisions.filter((item) => item.source === 'unavailable');
      if (unavailable.length)
        await tx.$executeRaw`
          UPDATE miniapp_features.free_zone_calls
          SET cost_source = 'unavailable', settled_at = now()
          WHERE id = ANY(${unavailable.map((item) => item.id)}::uuid[]) AND cost_source IS NULL`;
      return decisions.length;
    },
    { timeout: 30_000 }
  );
}

function openRouterCost(data: GenerationData | null) {
  if (!data || data.error) return null;
  const usage = data.usage;
  if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0) return null;
  const tokens = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  return {
    costUsd: usage.toFixed(9),
    promptTokens: tokens(data.native_tokens_prompt),
    completionTokens: tokens(data.native_tokens_completion),
  };
}

/**
 * 被取消/超时、查不到花费的兜底按这个值记：近 7 天同样中途停下、查到了花费的兜底平均花费
 * （样本太少时用全部兜底的平均）。每 6 小时算一次；还没有任何样本时返回空，这些调用留到下一轮。
 */
async function fallbackEstimate(now: number): Promise<string | null> {
  if (estimateCache && now - estimateCache.at < ESTIMATE_REFRESH_MS) return estimateCache.usd;
  const [row] = await prisma.$queryRaw<
    Array<{ stopped: string | null; stopped_samples: bigint; overall: string | null }>
  >`
    SELECT (avg(cost_usd) FILTER (WHERE end_reason = ANY(${STOPPED_REASONS}::text[])))::text AS stopped,
      count(*) FILTER (WHERE end_reason = ANY(${STOPPED_REASONS}::text[])) AS stopped_samples,
      avg(cost_usd)::text AS overall
    FROM miniapp_features.free_zone_calls
    WHERE role = 'fallback' AND cost_source = 'openrouter_generation'
      AND dispatched_at > now() - interval '7 days'`;
  const usd =
    row && Number(row.stopped_samples) >= MIN_ESTIMATE_SAMPLES
      ? row.stopped
      : (row?.overall ?? null);
  if (usd === null) return null;
  estimateCache = { usd: Number(usd).toFixed(9), at: now };
  return estimateCache.usd;
}

/** 兜底查不到真实花费：中途停下的记估算值，一发出就报错的记 0 */
async function settleWithoutCost(rows: PendingRow[], now: number): Promise<number> {
  const stopped = rows.filter((row) => STOPPED_REASONS.includes(row.end_reason));
  await markUnavailable(rows.filter((row) => !stopped.includes(row)).map((row) => row.id));
  const usd = stopped.length ? await fallbackEstimate(now) : null;
  if (usd !== null)
    await saveCosts(
      prisma,
      stopped.map((row) => ({
        id: row.id,
        source: 'estimated',
        costUsd: usd,
        requestId: null,
        promptTokens: null,
        completionTokens: null,
      }))
    );
  return rows.length - (usd === null ? stopped.length : 0);
}

/** OpenRouter 兜底：按生成编号逐个查 */
async function settleOpenRouter(deps: CallCostDeps): Promise<number> {
  const now = deps.now();
  const pending = await loadPending('openrouter', now);
  const lookups = pending.filter((row) => row.generation_id).slice(0, OPENROUTER_PER_RUN);
  const settled: Parameters<typeof saveCosts>[1] = [];
  const failed: PendingRow[] = [];
  let next = 0;
  const worker = async () => {
    while (next < lookups.length) {
      const row = lookups[next++]!;
      const cost = openRouterCost(await deps.fetchGeneration(row.generation_id!));
      if (cost)
        settled.push({ id: row.id, source: 'openrouter_generation', requestId: null, ...cost });
      else failed.push(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, lookups.length) }, worker));
  await saveCosts(prisma, settled);
  const giveUp = failed.filter(
    (row) =>
      row.cost_attempts + 1 >= OPENROUTER_MAX_ATTEMPTS ||
      now - row.dispatched_at.getTime() >= GIVE_UP_MS
  );
  const retry = failed.filter((row) => !giveUp.includes(row)).map((row) => row.id);
  if (retry.length)
    await prisma.$executeRaw`
      UPDATE miniapp_features.free_zone_calls SET cost_attempts = cost_attempts + 1
      WHERE id = ANY(${retry}::uuid[]) AND cost_source IS NULL`;
  const withoutCost = [...pending.filter((row) => !row.generation_id), ...giveUp];
  return settled.length + (await settleWithoutCost(withoutCost, now));
}

export async function runFreeZoneCallCosts(
  log: FastifyBaseLogger,
  deps: CallCostDeps = defaultDeps
): Promise<void> {
  return runObservedJob(JOB, async () => {
    const startedAt = performance.now();
    if (running) {
      observeBackgroundRun({ job: JOB, outcome: 'skipped', startedAt });
      return;
    }
    running = true;
    try {
      // 两部分互不依赖：一边的外部接口出错不耽误另一边
      const [surplus, openrouter] = await Promise.allSettled([
        settleSurplus(deps),
        settleOpenRouter(deps),
      ]);
      const other = await loadPending('other', deps.now());
      await markUnavailable(other.map((row) => row.id));
      for (const result of [surplus, openrouter])
        if (result.status === 'rejected')
          log.warn(
            { kind: 'sys', event: 'free_zone.call_costs_partial', err: result.reason },
            '畅聊调用花费本轮部分没补上'
          );
      log.info(
        {
          kind: 'sys',
          event: 'free_zone.call_costs_done',
          surplus: surplus.status === 'fulfilled' ? surplus.value : null,
          openrouter: openrouter.status === 'fulfilled' ? openrouter.value : null,
        },
        '畅聊调用花费核算完成'
      );
      observeBackgroundRun({ job: JOB, outcome: 'success', startedAt });
    } catch (err) {
      log.error({ kind: 'sys', event: 'free_zone.call_costs_failed', err }, '畅聊调用花费核算失败');
      observeBackgroundRun({ job: JOB, outcome: 'error', startedAt, error: err });
    } finally {
      running = false;
    }
  });
}

export function startFreeZoneCallCostJob(log: FastifyBaseLogger): void {
  if (timer || startupTimer) return;
  const jlog = log.child({ module: 'free-zone' });
  timer = setInterval(() => void runFreeZoneCallCosts(jlog), INTERVAL_MS);
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runFreeZoneCallCosts(jlog);
  }, STARTUP_DELAY_MS);
}

export function stopFreeZoneCallCostJob(): void {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}
