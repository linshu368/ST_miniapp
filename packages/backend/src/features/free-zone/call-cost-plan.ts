/**
 * 畅聊上游调用的 Surplus 花费核算（纯函数）：拿账单明细给还没定花费的调用定价。
 *
 * - 有请求号：账单里按请求号找。
 * - 没请求号（响应头前就取消了）：Surplus 照样收费，账单里会多出一行我们不认识的请求号。
 *   按「同一模型、在发出之后结算」配给最早的那一行。同一模型的两次调用配反了不影响
 *   按模型统计；拨测只发几个字，按输入 token 太少排除。
 * - 过了 GIVE_UP_MS 还找不到：记为查不到（免费模型主请求按 0 算，见视图）。
 */
import type { SurplusUsageRow } from './surplus-usage-export.js';

/** 发出后至少等这么久再核算：账单在调用结算后才出现，单轮最长 110 秒 */
export const SETTLE_AFTER_MS = 3 * 60 * 1000;
export const GIVE_UP_MS = 2 * 60 * 60 * 1000;
/** 拨测只发「只回复一个字：好」，真实对话的上下文远大于这个数 */
const MIN_CHAT_INPUT_TOKENS = 200;
/** 账单时间是结算时间；允许少许时钟误差，最晚找到发出后 10 分钟 */
const MATCH_EARLY_MS = 5_000;
const MATCH_LATE_MS = 10 * 60 * 1000;

export interface PendingSurplusCall {
  id: string;
  providerModel: string;
  dispatchedAt: number;
  requestId: string | null;
}

export type SurplusCostDecision =
  | {
      id: string;
      source: 'surplus_bill' | 'surplus_bill_matched';
      requestId: string;
      costUsd: string;
      promptTokens: number;
      completionTokens: number;
    }
  | { id: string; source: 'unavailable' };

export function planSurplusCosts(input: {
  pending: PendingSurplusCall[];
  usage: SurplusUsageRow[];
  /** 已经归属某次调用的请求号（含已核算、待核算的，以及每轮调用明细表里的） */
  knownRequestIds: ReadonlySet<string>;
  now: number;
}): SurplusCostDecision[] {
  const byId = new Map(input.usage.map((row) => [row.requestId, row]));
  const unclaimed = input.usage
    .filter(
      (row) => !input.knownRequestIds.has(row.requestId) && row.inputTokens >= MIN_CHAT_INPUT_TOKENS
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  const used = new Set<string>();
  const decisions: SurplusCostDecision[] = [];
  const settled = (call: PendingSurplusCall, row: SurplusUsageRow, matched: boolean) =>
    decisions.push({
      id: call.id,
      source: matched ? 'surplus_bill_matched' : 'surplus_bill',
      requestId: row.requestId,
      costUsd: row.costUsd,
      promptTokens: row.inputTokens,
      completionTokens: row.outputTokens,
    });
  const ready = input.pending
    .filter((call) => input.now - call.dispatchedAt >= SETTLE_AFTER_MS)
    .sort((a, b) => a.dispatchedAt - b.dispatchedAt);
  for (const call of ready) {
    const expired = input.now - call.dispatchedAt >= GIVE_UP_MS;
    if (call.requestId) {
      const row = byId.get(call.requestId);
      if (row) settled(call, row, false);
      else if (expired) decisions.push({ id: call.id, source: 'unavailable' });
      continue;
    }
    const row = unclaimed.find(
      (item) =>
        !used.has(item.requestId) &&
        item.model === call.providerModel &&
        item.createdAt >= call.dispatchedAt - MATCH_EARLY_MS &&
        item.createdAt <= call.dispatchedAt + MATCH_LATE_MS
    );
    if (row) {
      used.add(row.requestId);
      settled(call, row, true);
    } else if (expired) decisions.push({ id: call.id, source: 'unavailable' });
  }
  return decisions;
}
