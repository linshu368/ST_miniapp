/**
 * 余额不足 → 充值页。四处调用点（聊天 SSE、聊天语音、自定义台词、模型切换）
 * 都走这里，避免再各写一套 query 和错误码。
 *
 * 后端错误码还没统一：对话/语音是 `insufficient_balance`，切模型是
 * `INSUFFICIENT_CREDITS`。这里只统一前端谓词，不改 API。
 */

import type { PaywallTriggerSource } from '@miniapp/shared';

import {
  chatIdentityFromReturnTo,
  patchPaywallContinuation,
  writePaywallContinuation,
} from '@/lib/payment/paywall-continuation';
import { getReplayLifecycle } from '@/lib/telemetry';

const INSUFFICIENT_CREDIT_CODES = new Set(['insufficient_balance', 'INSUFFICIENT_CREDITS']);

export interface RechargeRedirectInput {
  returnTo: string;
  requiredCredits?: number;
  /** T5 四个调用点传入；缺省时仍跳转，但不发 paywall_triggered。 */
  triggerSource?: PaywallTriggerSource;
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

function writePaywallContinuationNow(
  input: RechargeRedirectInput,
  replayContextId: string | null
): void {
  writePaywallContinuation({
    triggerSource: input.triggerSource,
    requiredCredits: input.requiredCredits,
    returnTo: input.returnTo,
    replayContextId,
  });
}

function capturePaywallTriggered(input: RechargeRedirectInput): void {
  if (!input.triggerSource) return;
  const identity = chatIdentityFromReturnTo(input.returnTo);
  if (!identity) return;
  const lifecycle = getReplayLifecycle();
  lifecycle.capture({
    event: 'paywall_triggered',
    trigger_source: input.triggerSource,
    character_id: identity.characterId,
    conversation_session_id: identity.conversationSessionId,
    selected_model_id: null,
    ...(input.requiredCredits !== undefined &&
    Number.isInteger(input.requiredCredits) &&
    input.requiredCredits > 0
      ? { required_credits: input.requiredCredits }
      : {}),
  });
  patchPaywallContinuation({ lastObservedAction: 'paywall_triggered' });
}

export async function redirectToRecharge(
  router: RechargeRouter,
  input: RechargeRedirectInput
): Promise<void> {
  const lifecycle = getReplayLifecycle();
  // hold 必须在 push 前同步置位；await 队列会把导航绑到 startChatReplay/whenReady/SDK import。
  const followup = lifecycle.enterPaywallFollowup();
  writePaywallContinuationNow(input, lifecycle.getSnapshot().replayContextId);
  router.push(rechargePath(input));

  try {
    await followup;
  } catch {
    return;
  }
  const replayContextId = lifecycle.getSnapshot().replayContextId;
  if (replayContextId) {
    patchPaywallContinuation({ replayContextId });
  }
  capturePaywallTriggered(input);
}

/** 认出余额不足就跳充值并返回 true，否则 false，调用方继续走自己的失败分流。 */
export function redirectToRechargeFromError(
  router: RechargeRouter,
  error: unknown,
  returnTo: string,
  triggerSource?: PaywallTriggerSource
): boolean {
  if (!isInsufficientCreditsError(error)) return false;
  void redirectToRecharge(router, {
    returnTo,
    requiredCredits: requiredCreditsFromError(error),
    triggerSource,
  });
  return true;
}
