/**
 * 余额不足 → 充值页。四处调用点（聊天 SSE、聊天语音、自定义台词、模型切换）
 * 都走这里，避免再各写一套 query 和错误码。
 *
 * 后端错误码还没统一：对话/语音是 `insufficient_balance`，切模型是
 * `INSUFFICIENT_CREDITS`。这里只统一前端谓词，不改 API。
 */

const INSUFFICIENT_CREDIT_CODES = new Set(['insufficient_balance', 'INSUFFICIENT_CREDITS']);

export interface RechargeRedirectInput {
  returnTo: string;
  requiredCredits?: number;
}

interface RechargeRouter {
  push: (href: string) => void;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isInsufficientCreditsError(error: unknown): boolean {
  const code = readErrorCode(error);
  return code !== undefined && INSUFFICIENT_CREDIT_CODES.has(code);
}

export function requiredCreditsFromError(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const required = (error as { balance?: { creditsRequired?: unknown } }).balance?.creditsRequired;
  return typeof required === 'number' && Number.isFinite(required) ? required : undefined;
}

export function rechargePath(input: RechargeRedirectInput): string {
  const search = new URLSearchParams({
    reason: 'insufficient_credits',
    returnTo: input.returnTo,
  });
  if (input.requiredCredits !== undefined) {
    search.set('required', String(input.requiredCredits));
  }
  return `/profile/recharge?${search.toString()}`;
}

export function redirectToRecharge(router: RechargeRouter, input: RechargeRedirectInput): void {
  router.push(rechargePath(input));
}

/** 认出余额不足就跳充值并返回 true，否则 false，调用方继续走自己的失败分流。 */
export function redirectToRechargeFromError(
  router: RechargeRouter,
  error: unknown,
  returnTo: string
): boolean {
  if (!isInsufficientCreditsError(error)) return false;
  redirectToRecharge(router, {
    returnTo,
    requiredCredits: requiredCreditsFromError(error),
  });
  return true;
}
