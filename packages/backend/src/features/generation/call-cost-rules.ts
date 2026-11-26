/**
 * 每次上游调用怎么补成本（纯函数，便于单测）。口径（用户 11-19）：
 * 每轮成本 = 首发 + 兜底全部调用之和；确实拿不到的不算（汇总按 0），Surplus 尤其如此——本来便宜，不影响大局。
 *
 * - 已有成本、只缺来源标记的：按供应商补标记。
 * - Surplus：代表 attempt 的那一行只用响应里的金额（由 Surplus 记录函数写入），结算后 2 小时仍没有就记 unavailable；
 *   不代表 attempt 的行（畅聊专用兜底、出字后重写、并发落败）没人写金额，20 分钟后按请求号查 Surplus 请求记录
 *   （surplus-call-costs.ts，最多 8 次、24 小时内），没请求号或查不到记 unavailable。
 * - Venice：交付调用的用量由元数据补齐写入；其余记 unavailable（量小）。
 * - OpenRouter（兜底几乎都是它，且贵）：有生成编号就查（最多 8 次、24 小时内）；查不到或没有编号的，
 *   中途停下（被取消 / 首字超时）的粗估为"本轮输入 token × 该模型输入单价"（用户 11-20 定）：
 *   被取消的调用主要花在输入上；输入 token 取同一轮其他调用上报的值，单价取 OpenRouter 模型目录。
 *   拿不到输入 token 或单价的记 unavailable；一发出就失败的也记 unavailable。
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
/** 不代表 attempt 的 Surplus 行没有别的写入方，不用等 2 小时 */
const SURPLUS_UNOWNED_SETTLE_MS = 20 * 60 * 1000;
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
  /** Surplus 请求号（x-si-request-id） */
  requestId?: string | null;
  /** 这一行代表 attempt（attempt_id 非空）；Surplus 的这一行由记录函数写金额 */
  representsAttempt?: boolean;
}

export type CostDecision =
  | 'known'
  | 'wait'
  | 'lookup'
  | 'surplus_lookup'
  | 'estimate'
  | 'unavailable';

export function planPendingCall(call: PendingCall, now: number): CostDecision {
  const age = now - call.dispatchedAt;
  if (call.hasCost) return KNOWN_SOURCE_BY_PROVIDER[call.provider] ? 'known' : 'unavailable';
  if (age >= PENDING_WINDOW_MS) return 'unavailable';
  if (call.provider === 'surplus' && call.representsAttempt === false) {
    if (age < SURPLUS_UNOWNED_SETTLE_MS) return 'wait';
    return call.requestId && call.attempts < OPENROUTER_MAX_ATTEMPTS && age < LOOKUP_UNTIL_MS
      ? 'surplus_lookup'
      : 'unavailable';
  }
  if (age < (SETTLE_AFTER_MS[call.provider] ?? SETTLE_AFTER_MS.openrouter!)) return 'wait';
  if (call.provider !== 'openrouter') return 'unavailable';
  if (call.generationId && call.attempts < OPENROUTER_MAX_ATTEMPTS && age < LOOKUP_UNTIL_MS)
    return 'lookup';
  return call.endReason !== null && STOPPED_REASONS.includes(call.endReason)
    ? 'estimate'
    : 'unavailable';
}

export interface PricedModel {
  id: string;
  canonical_slug: string | null;
  prompt_usd_per_token: number;
}

/** 模型 → 输入单价（美元 / token）。调用行里记的是请求时的模型 ID，同时收录带日期的规范名作兜底 */
export function promptPriceIndex(models: readonly PricedModel[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const model of models) index.set(model.id, model.prompt_usd_per_token);
  for (const model of models)
    if (model.canonical_slug && !index.has(model.canonical_slug))
      index.set(model.canonical_slug, model.prompt_usd_per_token);
  return index;
}

/** 粗估被取消调用的成本：输入 token × 输入单价；任一项缺失或不合法就不估（记 unavailable） */
export function estimatePromptCost(
  promptTokens: number | null,
  promptUsdPerToken: number | null | undefined
): string | null {
  if (promptTokens === null || !Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  if (
    promptUsdPerToken === null ||
    promptUsdPerToken === undefined ||
    !Number.isFinite(promptUsdPerToken) ||
    promptUsdPerToken < 0
  )
    return null;
  return (promptTokens * promptUsdPerToken).toFixed(9);
}
