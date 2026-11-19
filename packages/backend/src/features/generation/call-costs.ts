/**
 * 模型调用成本补查任务：每 10 分钟给 ops.llm_calls 里还没定成本的调用（收费轮与畅聊、首发与兜底）补上成本。
 * 规则见 call-cost-rules.ts；每轮总成本见视图 miniapp_analytics.llm_turn_costs。
 *
 * 只写成本相关列且只改 cost_source 仍为空的行：Surplus 记录函数、元数据补齐（sync-job）先写的，这里不覆盖。
 * 外部接口拿不到就本轮跳过，下一轮再补；OpenRouter 查询次数记在 ops.llm_cost_jobs（kind = call_cost）。
 */
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/db.js';
import { observeBackgroundRun } from '../../lib/background-observability.js';
import { runObservedJob } from '../../platform/observability/jobs.js';
import { fetchGenerationData, type GenerationData } from './openrouter-metadata.js';
import {
  KNOWN_SOURCE_BY_PROVIDER,
  OPENROUTER_MAX_ATTEMPTS,
  PENDING_WINDOW_MS,
  STOPPED_REASONS,
  pickEstimate,
  planPendingCall,
  type CostDecision,
} from './call-cost-rules.js';

const JOB = 'llm_call_costs';
const INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const BATCH = 2000;
const OPENROUTER_PER_RUN = 60;
const ESTIMATE_REFRESH_MS = 6 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let running = false;
let estimateCache: { usd: string; at: number } | null = null;

interface PendingRow {
  id: string;
  provider: string;
  end_reason: string | null;
  generation_id: string | null;
  dispatched_at: Date;
  attempts: number;
  has_cost: boolean;
}

export interface CallCostDeps {
  fetchGeneration(id: string): Promise<GenerationData | null>;
  now(): number;
}

const defaultDeps: CallCostDeps = {
  fetchGeneration: fetchGenerationData,
  now: () => Date.now(),
};

async function loadPending(now: number): Promise<PendingRow[]> {
  return prisma.$queryRaw<PendingRow[]>`
    SELECT l.id::text, l.provider, l.end_reason, l.generation_id, l.dispatched_at,
      COALESCE(j.attempts, 0)::int AS attempts, (l.cost_usd IS NOT NULL) AS has_cost
    FROM ops.llm_calls l
    LEFT JOIN ops.llm_cost_jobs j ON j.call_id = l.id AND j.kind = 'call_cost'
    WHERE l.cost_source IS NULL AND l.dispatched_at IS NOT NULL
      AND l.dispatched_at >= ${new Date(now - PENDING_WINDOW_MS)}
    ORDER BY l.dispatched_at
    LIMIT ${BATCH}`;
}

async function setSource(ids: string[], source: string): Promise<void> {
  if (!ids.length) return;
  await prisma.$executeRaw`
    UPDATE ops.llm_calls SET cost_source = ${source}, updated_at = now()
    WHERE id = ANY(${ids}::uuid[]) AND cost_source IS NULL`;
}

async function closeJobs(ids: string[], status: 'complete' | 'unavailable'): Promise<void> {
  if (!ids.length) return;
  await prisma.$executeRaw`
    UPDATE ops.llm_cost_jobs SET status = ${status}, updated_at = now()
    WHERE call_id = ANY(${ids}::uuid[]) AND kind = 'call_cost' AND status = 'pending'`;
}

function openRouterCost(data: GenerationData | null) {
  if (!data || data.error) return null;
  const usage = data.usage;
  if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0) return null;
  const tokens = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? String(value) : '';
  return {
    costUsd: usage.toFixed(9),
    prompt: tokens(data.native_tokens_prompt),
    completion: tokens(data.native_tokens_completion),
  };
}

async function lookupOpenRouter(rows: PendingRow[], deps: CallCostDeps): Promise<number> {
  const lookups = rows.slice(0, OPENROUTER_PER_RUN);
  const found: Array<{ id: string; costUsd: string; prompt: string; completion: string }> = [];
  const missed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < lookups.length) {
      const row = lookups[next++]!;
      const cost = openRouterCost(await deps.fetchGeneration(row.generation_id!));
      if (cost) found.push({ id: row.id, ...cost });
      else missed.push(row.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, lookups.length) }, worker));
  if (found.length) {
    await prisma.$executeRaw`
      UPDATE ops.llm_calls l
      SET cost_usd = u.cost::numeric, cost_source = 'openrouter_usage',
        prompt_tokens = COALESCE(l.prompt_tokens, NULLIF(u.prompt, '')::bigint),
        completion_tokens = COALESCE(l.completion_tokens, NULLIF(u.completion, '')::bigint),
        updated_at = now()
      FROM unnest(${found.map((item) => item.id)}::uuid[], ${found.map((item) => item.costUsd)}::text[],
        ${found.map((item) => item.prompt)}::text[], ${found.map((item) => item.completion)}::text[])
        AS u(id, cost, prompt, completion)
      WHERE l.id = u.id AND l.cost_source IS NULL`;
    await closeJobs(
      found.map((item) => item.id),
      'complete'
    );
  }
  if (missed.length)
    await prisma.$executeRaw`
      INSERT INTO ops.llm_cost_jobs AS j (call_id, kind, status, attempts, updated_at)
      SELECT id, 'call_cost', 'pending', 1, now() FROM unnest(${missed}::uuid[]) AS id
      ON CONFLICT (call_id) DO UPDATE
        SET attempts = least(j.attempts + 1, ${OPENROUTER_MAX_ATTEMPTS}::int), updated_at = now()
        WHERE j.kind = 'call_cost'`;
  return found.length;
}

/** 近 7 天中途停下、查到真实成本的 OpenRouter 调用均价（样本不足时用全部查到真实成本的兜底均价），每 6 小时算一次 */
async function stoppedEstimate(now: number): Promise<string | null> {
  if (estimateCache && now - estimateCache.at < ESTIMATE_REFRESH_MS) return estimateCache.usd;
  const [row] = await prisma.$queryRaw<
    Array<{ stopped: string | null; stopped_samples: bigint; fallback: string | null }>
  >`
    SELECT (avg(cost_usd) FILTER (WHERE end_reason = ANY(${STOPPED_REASONS as string[]}::text[])))::text AS stopped,
      count(*) FILTER (WHERE end_reason = ANY(${STOPPED_REASONS as string[]}::text[])) AS stopped_samples,
      (avg(cost_usd) FILTER (WHERE role = 'fallback'))::text AS fallback
    FROM ops.llm_calls
    WHERE provider = 'openrouter' AND cost_usd IS NOT NULL
      AND cost_source IN ('openrouter_usage', 'openrouter_generation')
      AND dispatched_at > now() - interval '7 days'`;
  const usd = pickEstimate({
    stoppedAvg: row?.stopped ?? null,
    stoppedSamples: Number(row?.stopped_samples ?? 0),
    fallbackAvg: row?.fallback ?? null,
  });
  if (usd === null) return null;
  estimateCache = { usd, at: now };
  return usd;
}

async function estimate(ids: string[], now: number): Promise<number> {
  if (!ids.length) return 0;
  const usd = await stoppedEstimate(now);
  // 还没有任何样本：留到下一轮
  if (usd === null) return 0;
  await prisma.$executeRaw`
    UPDATE ops.llm_calls SET cost_usd = ${usd}::numeric, cost_source = 'estimated', updated_at = now()
    WHERE id = ANY(${ids}::uuid[]) AND cost_source IS NULL`;
  await closeJobs(ids, 'unavailable');
  return ids.length;
}

export async function settleCallCosts(deps: CallCostDeps = defaultDeps) {
  const now = deps.now();
  const pending = await loadPending(now);
  const by: Record<CostDecision, PendingRow[]> = {
    known: [],
    wait: [],
    lookup: [],
    estimate: [],
    unavailable: [],
  };
  for (const row of pending)
    by[
      planPendingCall(
        {
          id: row.id,
          provider: row.provider,
          endReason: row.end_reason,
          generationId: row.generation_id,
          dispatchedAt: row.dispatched_at.getTime(),
          attempts: row.attempts,
          hasCost: row.has_cost,
        },
        now
      )
    ].push(row);
  for (const [provider, source] of Object.entries(KNOWN_SOURCE_BY_PROVIDER))
    await setSource(
      by.known.filter((row) => row.provider === provider).map((row) => row.id),
      source
    );
  const looked = await lookupOpenRouter(by.lookup, deps);
  const estimated = await estimate(
    by.estimate.map((row) => row.id),
    now
  );
  const unavailable = by.unavailable.map((row) => row.id);
  await setSource(unavailable, 'unavailable');
  await closeJobs(unavailable, 'unavailable');
  return {
    pending: pending.length,
    known: by.known.length,
    looked,
    estimated,
    unavailable: unavailable.length,
  };
}

export async function runCallCosts(
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
      const result = await settleCallCosts(deps);
      log.info({ kind: 'sys', event: 'llm.call_costs_done', ...result }, '模型调用成本补查完成');
      observeBackgroundRun({ job: JOB, outcome: 'success', startedAt });
    } catch (err) {
      log.error({ kind: 'sys', event: 'llm.call_costs_failed', err }, '模型调用成本补查失败');
      observeBackgroundRun({ job: JOB, outcome: 'error', startedAt, error: err });
    } finally {
      running = false;
    }
  });
}

export function startCallCostJob(log: FastifyBaseLogger): void {
  if (timer || startupTimer) return;
  const jlog = log.child({ module: 'generation' });
  timer = setInterval(() => void runCallCosts(jlog), INTERVAL_MS);
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runCallCosts(jlog);
  }, STARTUP_DELAY_MS);
}

export function stopCallCostJob(): void {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}
