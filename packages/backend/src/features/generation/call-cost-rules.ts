/**
 * 每次上游调用怎么补成本（纯函数，便于单测）。口径（用户 11-19）：
 * 每轮成本 = 首发 + 兜底全部调用之和；确实拿不到的不算（汇总按 0），Surplus 尤其如此——本来便宜，不影响大局。
 *
 * - 已有成本、只缺来源标记的：按供应商补标记。
 * - Surplus：只用响应里的金额（由 Surplus 记录函数写入）；结算后 2 小时仍没有就记 unavailable，不再拉账单对账。
 * - Venice：交付调用的用量由元数据补齐写入；其余记 unavailable（量小）。
 * - OpenRouter（兜底几乎都是它，且贵）：有生成编号就查（最多 8 次、24 小时内）；查不到或没有编号的，
 *   中途停下（被取消 / 首字超时）的按近 7 天同类已知成本的均价估，一发出就失败的记 unavailable。
 */
export const STOPPED_REASONS: readonly string[] = ['cancelled', 'first_token_deadline'];
export const OPENROUTER_MAX_ATTEMPTS = 8;
export const PENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SETTLE_AFTER_MS: Record<string, number> = {
  openrouter: 20 * 60 * 1000,
  venice: 20 * 60 * 1000,
  // Surplus 请求记录补查可能稍后补上响应金额
  surplus: 2 * 60 * 60 * 1000,
};
const LOOKUP_UNTIL_MS = 24 * 60 * 60 * 1000;

export const KNOWN_SOURCE_BY_PROVIDER: Record<string, string> = {
  surplus: 'surplus_buyer',
  openrouter: 'openrouter_usage',
  venice: 'venice_usage',
};

export interface PendingCall {
  id: string;
  provider: string;
  endReason: string | null;
  generationId: string | null;
  dispatchedAt: number;
  attempts: number;
  hasCost: boolean;
}

export type CostDecision = 'known' | 'wait' | 'lookup' | 'estimate' | 'unavailable';

export function planPendingCall(call: PendingCall, now: number): CostDecision {
  const age = now - call.dispatchedAt;
  if (call.hasCost) return KNOWN_SOURCE_BY_PROVIDER[call.provider] ? 'known' : 'unavailable';
  if (age >= PENDING_WINDOW_MS) return 'unavailable';
  if (age < (SETTLE_AFTER_MS[call.provider] ?? SETTLE_AFTER_MS.openrouter!)) return 'wait';
  if (call.provider !== 'openrouter') return 'unavailable';
  if (call.generationId && call.attempts < OPENROUTER_MAX_ATTEMPTS && age < LOOKUP_UNTIL_MS)
    return 'lookup';
  return call.endReason !== null && STOPPED_REASONS.includes(call.endReason)
    ? 'estimate'
    : 'unavailable';
}

/** 估价：中途停下且查到真实成本的样本够 5 条就用它们的均价，否则用全部查到真实成本的兜底均价；都没有就先不估 */
export function pickEstimate(input: {
  stoppedAvg: string | null;
  stoppedSamples: number;
  fallbackAvg: string | null;
}): string | null {
  const usd = input.stoppedSamples >= 5 ? input.stoppedAvg : input.fallbackAvg;
  if (usd === null) return null;
  const value = Number(usd);
  return Number.isFinite(value) && value >= 0 ? value.toFixed(9) : null;
}
