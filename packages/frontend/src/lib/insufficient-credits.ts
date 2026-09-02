/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-02 10:55:54
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-02 10:55:57
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
export interface InsufficientCreditsBalance {
  creditsRequired: number;
}

/** 兼容流式对话、普通 API 与历史模型选择接口的余额不足错误码。 */
export function isInsufficientCreditsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'insufficient_balance' || code === 'INSUFFICIENT_CREDITS';
}

export function readCreditsRequired(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const balance = (error as { balance?: unknown }).balance;
  if (!balance || typeof balance !== 'object') return undefined;
  const required = (balance as { creditsRequired?: unknown }).creditsRequired;
  return typeof required === 'number' && Number.isFinite(required) && required >= 0
    ? required
    : undefined;
}

/** 所有前端余额不足场景统一使用这一条充值路径和同一组查询参数。 */
export function buildInsufficientCreditsRechargePath(input: {
  returnTo: string;
  creditsRequired?: number;
}): string {
  const search = new URLSearchParams({
    reason: 'insufficient_credits',
    returnTo: input.returnTo,
  });
  if (
    typeof input.creditsRequired === 'number' &&
    Number.isFinite(input.creditsRequired) &&
    input.creditsRequired >= 0
  ) {
    search.set('required', String(input.creditsRequired));
  }
  return `/profile/recharge?${search.toString()}`;
}

export function buildInsufficientCreditsRechargePathFromError(
  error: unknown,
  returnTo: string
): string {
  return buildInsufficientCreditsRechargePath({
    returnTo,
    creditsRequired: readCreditsRequired(error),
  });
}
