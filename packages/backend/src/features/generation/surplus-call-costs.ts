/**
 * 不代表 attempt 的 Surplus 调用（畅聊专用兜底、出字后重写、并发落败）的成本：按请求号查 Surplus 请求记录取 buyer cost。
 * 这些行没有 Surplus 记录函数写金额（每轮那一行属于首发）。由 call-costs 任务每 10 分钟调一次，规则见 call-cost-rules.ts。
 *
 * 只读外部接口、只写 ops.llm_calls 成本列与 ops.llm_cost_jobs 次数；查不到就累计次数，下一轮再查，到上限记 unavailable。
 */
import { prisma } from '../../lib/db.js';
import { clientFetch } from '../../platform/observability/fetch.js';
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';
import { OPENROUTER_MAX_ATTEMPTS } from './call-cost-rules.js';
import { SurplusResponseCapture } from './surplus-response-capture.js';
import { readDetail, validateDetailIdentity } from './surplus-request-recovery.js';

const fetch = clientFetch('provider.surplus.call_cost', 'surplus');
const PER_RUN = 60;
const TIMEOUT_MS = 5_000;

export interface SurplusCostRow {
  id: string;
  requestId: string;
}

/** 美元金额字符串；拿不到为 null（未授权、404、超时、格式不对都算拿不到） */
export async function fetchSurplusRequestCostUsd(
  requestId: string,
  options: { fetchImpl?: typeof fetch; baseUrl: string; apiKey: string }
): Promise<string | null> {
  if (!/^[a-zA-Z0-9_.:-]{1,512}$/.test(requestId)) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `${options.baseUrl.replace(/\/+$/, '')}/requests/${encodeURIComponent(requestId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      }
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const detail = await readDetail(response);
    validateDetailIdentity(detail, { request_id: requestId, generation_id: null });
    const capture = new SurplusResponseCapture();
    capture.observe(detail, 'request_record');
    return capture.projection().usageUsd;
  } catch {
    // 不保留上游原文、URL 或异常内容
    return null;
  }
}

/** 返回查到成本的条数 */
export async function lookupSurplusCallCosts(
  rows: SurplusCostRow[],
  deps: { fetchCost?: (requestId: string) => Promise<string | null> } = {}
): Promise<number> {
  const lookups = rows.slice(0, PER_RUN);
  if (!lookups.length) return 0;
  const fetchCost =
    deps.fetchCost ??
    (() => {
      const runtime = getLlmProviderRuntimeConfig('surplus');
      if (!runtime.apiKey) return async () => null;
      return (requestId: string) =>
        fetchSurplusRequestCostUsd(requestId, {
          baseUrl: runtime.baseUrl,
          apiKey: runtime.apiKey!,
        });
    })();
  const found: Array<{ id: string; usd: string }> = [];
  const missed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < lookups.length) {
      const row = lookups[next++]!;
      const usd = await fetchCost(row.requestId);
      if (usd !== null) found.push({ id: row.id, usd });
      else missed.push(row.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, lookups.length) }, worker));
  if (found.length) {
    await prisma.$executeRaw`
      UPDATE ops.llm_calls l SET cost_usd = u.usd::numeric, cost_source = 'surplus_buyer', updated_at = now()
      FROM unnest(${found.map((item) => item.id)}::uuid[], ${found.map((item) => item.usd)}::text[])
        AS u(id, usd)
      WHERE l.id = u.id AND l.cost_source IS NULL`;
    await prisma.$executeRaw`
      UPDATE ops.llm_cost_jobs SET status = 'complete', updated_at = now()
      WHERE call_id = ANY(${found.map((item) => item.id)}::uuid[]) AND kind = 'call_cost'
        AND status = 'pending'`;
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
