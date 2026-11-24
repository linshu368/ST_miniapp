/**
 * 模型调用成本补查任务：每 10 分钟给 ops.llm_calls 里还没定成本的调用（收费轮与畅聊、首发与兜底）补上成本。
 * 规则见 call-cost-rules.ts；每轮总成本见视图 analytics.llm_turn_costs。
 *
 * 只写成本相关列且只改 cost_source 仍为空的行：Surplus 记录函数、元数据补齐（sync-job）先写的，这里不覆盖。
 * 外部接口拿不到就本轮跳过，下一轮再补；OpenRouter 查询次数记在 ops.llm_cost_jobs（kind = call_cost）。
 */
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/db.js';
import { observeBackgroundRun } from '../../lib/background-observability.js';
import { runObservedJob } from '../../platform/observability/jobs.js';
import { openRouterModelsClient } from '../../platform/openrouter-models.js';
import { fetchGenerationData, type GenerationData } from './openrouter-metadata.js';
import { settleRelayCallCosts } from './relay-call-costs.js';
import {
  KNOWN_SOURCE_BY_PROVIDER,
  OPENROUTER_MAX_ATTEMPTS,
  PENDING_WINDOW_MS,
  estimatePromptCost,
  planPendingCall,
  promptPriceIndex,
  type CostDecision,
  type PricedModel,
} from './call-cost-rules.js';

const JOB = 'llm_call_costs';
const INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const BATCH = 2000;
const OPENROUTER_PER_RUN = 60;

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let running = false;

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
  /** OpenRouter 模型目录（进程内缓存 15 分钟），取输入单价 */
  modelPrices(): Promise<readonly PricedModel[]>;
  now(): number;
}

const defaultDeps: CallCostDeps = {
  fetchGeneration: fetchGenerationData,
  modelPrices: async () => (await openRouterModelsClient.getModels()).models,
  now: () => Date.now(),
};

async function loadPending(now: number): Promise<PendingRow[]> {
  return prisma.$queryRaw<PendingRow[]>`
    SELECT l.id::text, l.provider, l.end_reason, l.generation_id, l.dispatched_at,
      COALESCE(j.attempts, 0)::int AS attempts, (l.cost_usd IS NOT NULL) AS has_cost
    FROM ops.llm_calls l
    LEFT JOIN ops.llm_cost_jobs j ON j.call_id = l.id AND j.kind = 'call_cost'
    WHERE l.cost_source IS NULL AND l.dispatched_at IS NOT NULL
      AND l.provider NOT IN ('packy', 'onexmodel')
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

interface EstimateInput {
  id: string;
  model: string | null;
  prompt_tokens: bigint | null;
}

/** 被取消调用自己没有用量：输入 token 取同一轮其他调用上报的值（优先同模型） */
async function loadEstimateInputs(ids: string[]): Promise<EstimateInput[]> {
  return prisma.$queryRaw<EstimateInput[]>`
    SELECT l.id::text, l.model,
      (SELECT s.prompt_tokens FROM ops.llm_calls s
       WHERE s.chat_history_id = l.chat_history_id AND s.id <> l.id AND s.prompt_tokens IS NOT NULL
       ORDER BY (s.model = l.model) DESC, s.dispatched_at NULLS LAST, s.id
       LIMIT 1) AS prompt_tokens
    FROM ops.llm_calls l
    WHERE l.id = ANY(${ids}::uuid[])`;
}

/** 粗估 = 输入 token × 模型输入单价；缺任一项记 unavailable。目录取不到就整批留到下一轮 */
async function estimate(
  ids: string[],
  deps: CallCostDeps
): Promise<{ estimated: number; unpriced: number; pricesUnavailable: boolean }> {
  if (!ids.length) return { estimated: 0, unpriced: 0, pricesUnavailable: false };
  let prices: Map<string, number>;
  try {
    prices = promptPriceIndex(await deps.modelPrices());
  } catch {
    return { estimated: 0, unpriced: 0, pricesUnavailable: true };
  }
  const priced: Array<{ id: string; usd: string }> = [];
  const unpriced: string[] = [];
  for (const row of await loadEstimateInputs(ids)) {
    const usd = estimatePromptCost(
      row.prompt_tokens === null ? null : Number(row.prompt_tokens),
      row.model === null ? null : prices.get(row.model)
    );
    if (usd === null) unpriced.push(row.id);
    else priced.push({ id: row.id, usd });
  }
  if (priced.length)
    await prisma.$executeRaw`
      UPDATE ops.llm_calls l SET cost_usd = u.usd::numeric, cost_source = 'estimated', updated_at = now()
      FROM unnest(${priced.map((item) => item.id)}::uuid[], ${priced.map((item) => item.usd)}::text[]) AS u(id, usd)
      WHERE l.id = u.id AND l.cost_source IS NULL`;
  await setSource(unpriced, 'unavailable');
  await closeJobs(ids, 'unavailable');
  return { estimated: priced.length, unpriced: unpriced.length, pricesUnavailable: false };
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
  const estimation = await estimate(
    by.estimate.map((row) => row.id),
    deps
  );
  const unavailable = by.unavailable.map((row) => row.id);
  await setSource(unavailable, 'unavailable');
  await closeJobs(unavailable, 'unavailable');
  return {
    pending: pending.length,
    known: by.known.length,
    looked,
    estimated: estimation.estimated,
    unavailable: unavailable.length + estimation.unpriced,
    // OpenRouter 模型目录取不到：待估调用整批留到下一轮
    prices_unavailable: estimation.pricesUnavailable,
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
      // Independent provider jobs cannot change existing providers' source/estimation rules.
      try {
        await settleRelayCallCosts();
      } catch (err) {
        log.warn(
          { kind: 'sys', event: 'llm.relay_call_costs_failed', err },
          '中转平台成本任务失败；既有成本任务结果保留'
        );
      }
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
