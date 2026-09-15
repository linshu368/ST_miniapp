import type { PaymentFlowLastObservedAction, PaywallTriggerSource } from '@miniapp/shared';

import { readSessionJson, removeSessionKey, writeSessionJson } from './session-storage';

export const PAYWALL_CONTINUATION_TTL_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'st.replay.paywall_continuation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaywallContinuation = {
  triggerSource?: PaywallTriggerSource;
  requiredCredits?: number;
  startedAt: number;
  characterId?: string;
  conversationSessionId?: string;
  selectedModelId: string | null;
  replayContextId: string | null;
  lastObservedAction?: PaymentFlowLastObservedAction;
  orderId?: string;
};

export type PaywallContinuationWriteInput = {
  triggerSource?: PaywallTriggerSource;
  requiredCredits?: number;
  returnTo: string;
  replayContextId: string | null;
  now?: number;
};

export function chatIdentityFromReturnTo(
  returnTo: string
): { characterId: string; conversationSessionId: string } | null {
  try {
    const url = new URL(returnTo, 'https://miniapp.local');
    const match = url.pathname.match(/^\/chat\/([^/]+)(?:\/voice\/[^/]+)?$/);
    if (!match?.[1]) return null;
    const characterId = decodeURIComponent(match[1]);
    const conversationSessionId = url.searchParams.get('session') ?? '';
    if (!UUID_RE.test(characterId) || !UUID_RE.test(conversationSessionId)) return null;
    return { characterId, conversationSessionId };
  } catch {
    return null;
  }
}

export function writePaywallContinuation(input: PaywallContinuationWriteInput): boolean {
  const identity = chatIdentityFromReturnTo(input.returnTo);
  const record: PaywallContinuation = {
    triggerSource: input.triggerSource,
    requiredCredits:
      input.requiredCredits !== undefined &&
      Number.isInteger(input.requiredCredits) &&
      input.requiredCredits > 0
        ? input.requiredCredits
        : undefined,
    startedAt: input.now ?? Date.now(),
    characterId: identity?.characterId,
    conversationSessionId: identity?.conversationSessionId,
    selectedModelId: null,
    replayContextId: input.replayContextId,
  };
  return writeSessionJson(STORAGE_KEY, record);
}

export function readPaywallContinuation(now: number = Date.now()): PaywallContinuation | null {
  const stored = readSessionJson<Partial<PaywallContinuation>>(STORAGE_KEY);
  if (!stored || typeof stored.startedAt !== 'number') return null;
  if (now - stored.startedAt > PAYWALL_CONTINUATION_TTL_MS) {
    removeSessionKey(STORAGE_KEY);
    return null;
  }
  return {
    triggerSource: stored.triggerSource,
    requiredCredits: stored.requiredCredits,
    startedAt: stored.startedAt,
    characterId: stored.characterId,
    conversationSessionId: stored.conversationSessionId,
    selectedModelId: stored.selectedModelId ?? null,
    replayContextId: stored.replayContextId ?? null,
    lastObservedAction: stored.lastObservedAction,
    orderId: stored.orderId,
  };
}

export function patchPaywallContinuation(patch: Partial<PaywallContinuation>): void {
  const current = readPaywallContinuation();
  if (!current) return;
  writeSessionJson(STORAGE_KEY, { ...current, ...patch });
}

export function clearPaywallContinuation(): void {
  removeSessionKey(STORAGE_KEY);
}

export function paywallDwellMs(now: number = Date.now()): number {
  const current = readPaywallContinuation(now);
  if (!current) return 0;
  return Math.max(0, now - current.startedAt);
}
