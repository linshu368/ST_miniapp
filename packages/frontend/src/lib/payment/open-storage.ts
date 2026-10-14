import type {
  CheckoutConfirmationAction,
  ExternalPaymentOpenFailureKind,
  PostCheckoutConfirmationRequest,
} from '@miniapp/shared';

import { safePaymentReturnTo } from '@/lib/utils/payment';

import { readSessionJson, removeSessionKey, writeSessionJson } from './session-storage';

export const PAYMENT_OPEN_TTL_MS = 30 * 60 * 1000;
export const MAX_CHECKOUT_CONFIRMATION_BACKFILLS = 2;
const STORAGE_KEY_PREFIX = 'st.replay.payment_open:';

type StoredCheckoutConfirmation = PostCheckoutConfirmationRequest & {
  pending_backfill: boolean;
  backfill_attempts: number;
};

type StoredPaymentOpen = {
  pay_url: string;
  returnTo: string | null;
  replay_context_id: string | null;
  created_at: number;
  checkout_confirmation?: StoredCheckoutConfirmation;
};

export type PaymentOpenWriteInput = {
  orderId: string;
  payUrl: string;
  returnTo: string | null;
  replayContextId: string | null;
  checkoutConfirmation?: PostCheckoutConfirmationRequest | null;
  now?: number;
};

export type PaymentOpenMeta = {
  returnTo: string | null;
  replayContextId: string | null;
  createdAt: number;
};

function storageKey(orderId: string): string {
  return `${STORAGE_KEY_PREFIX}${orderId}`;
}

function isCheckoutConfirmation(value: unknown): value is StoredCheckoutConfirmation {
  if (!value || typeof value !== 'object') return false;
  const confirmation = value as Partial<StoredCheckoutConfirmation>;
  return (
    typeof confirmation.request_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      confirmation.request_id
    ) &&
    typeof confirmation.occurred_at === 'string' &&
    Number.isFinite(Date.parse(confirmation.occurred_at)) &&
    (confirmation.action === 'initial_open' || confirmation.action === 'reopen') &&
    typeof confirmation.pending_backfill === 'boolean' &&
    typeof confirmation.backfill_attempts === 'number' &&
    Number.isInteger(confirmation.backfill_attempts) &&
    confirmation.backfill_attempts >= 0
  );
}

export function isAllowedPaymentOpenUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  if (/^weixin:\/\//i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function parseRecord(orderId: string, now: number): StoredPaymentOpen | null {
  const stored = readSessionJson<Partial<StoredPaymentOpen>>(storageKey(orderId));
  if (!stored || typeof stored.pay_url !== 'string' || typeof stored.created_at !== 'number') {
    return null;
  }
  if (now - stored.created_at > PAYMENT_OPEN_TTL_MS) {
    removeSessionKey(storageKey(orderId));
    return null;
  }
  if (!isAllowedPaymentOpenUrl(stored.pay_url)) {
    removeSessionKey(storageKey(orderId));
    return null;
  }
  return {
    pay_url: stored.pay_url,
    returnTo: typeof stored.returnTo === 'string' ? stored.returnTo : null,
    replay_context_id:
      typeof stored.replay_context_id === 'string' ? stored.replay_context_id : null,
    created_at: stored.created_at,
    ...(isCheckoutConfirmation(stored.checkout_confirmation)
      ? { checkout_confirmation: stored.checkout_confirmation }
      : {}),
  };
}

function newCheckoutConfirmation(
  action: CheckoutConfirmationAction,
  now: number
): PostCheckoutConfirmationRequest | null {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return null;
  return {
    request_id: crypto.randomUUID(),
    occurred_at: new Date(now).toISOString(),
    action,
  };
}

export function createCheckoutConfirmation(
  action: CheckoutConfirmationAction,
  now: number = Date.now()
): PostCheckoutConfirmationRequest | null {
  return newCheckoutConfirmation(action, now);
}

export function persistPaymentOpen(
  input: PaymentOpenWriteInput
): ExternalPaymentOpenFailureKind | undefined {
  if (!isAllowedPaymentOpenUrl(input.payUrl)) return 'invalid_url';
  const written = writeSessionJson(storageKey(input.orderId), {
    pay_url: input.payUrl.trim(),
    returnTo: input.returnTo ? safePaymentReturnTo(input.returnTo) : null,
    replay_context_id: input.replayContextId,
    created_at: input.now ?? Date.now(),
    ...(input.checkoutConfirmation
      ? {
          checkout_confirmation: {
            ...input.checkoutConfirmation,
            pending_backfill: true,
            backfill_attempts: 0,
          },
        }
      : {}),
  } satisfies StoredPaymentOpen);
  return written ? undefined : 'storage_unavailable';
}

/** Reopen keeps the original record's URL but creates a distinct, persistable intent. */
export function prepareReopenCheckoutConfirmation(
  orderId: string,
  now: number = Date.now()
): PostCheckoutConfirmationRequest | null {
  const stored = parseRecord(orderId, now);
  const confirmation = newCheckoutConfirmation('reopen', now);
  if (!stored || !confirmation) return confirmation;
  writeSessionJson(storageKey(orderId), {
    ...stored,
    checkout_confirmation: {
      ...confirmation,
      pending_backfill: true,
      backfill_attempts: 0,
    },
  } satisfies StoredPaymentOpen);
  return confirmation;
}

export function takePendingCheckoutConfirmation(
  orderId: string,
  now: number = Date.now()
): PostCheckoutConfirmationRequest | null {
  const stored = parseRecord(orderId, now);
  const confirmation = stored?.checkout_confirmation;
  if (
    !confirmation ||
    !confirmation.pending_backfill ||
    confirmation.backfill_attempts >= MAX_CHECKOUT_CONFIRMATION_BACKFILLS
  ) {
    return null;
  }
  const next = {
    ...confirmation,
    backfill_attempts: confirmation.backfill_attempts + 1,
  } satisfies StoredCheckoutConfirmation;
  writeSessionJson(storageKey(orderId), {
    ...stored,
    checkout_confirmation: next,
  } satisfies StoredPaymentOpen);
  return {
    request_id: next.request_id,
    occurred_at: next.occurred_at,
    action: next.action,
  };
}

export function clearCheckoutConfirmation(
  orderId: string,
  requestId: string,
  now: number = Date.now()
): void {
  const stored = parseRecord(orderId, now);
  if (!stored?.checkout_confirmation || stored.checkout_confirmation.request_id !== requestId)
    return;
  const { checkout_confirmation: _confirmation, ...withoutConfirmation } = stored;
  writeSessionJson(storageKey(orderId), withoutConfirmation satisfies StoredPaymentOpen);
}

export function readPaymentOpenUrl(orderId: string, now: number = Date.now()): string | null {
  return parseRecord(orderId, now)?.pay_url ?? null;
}

export function hasPaymentOpenUrl(orderId: string, now: number = Date.now()): boolean {
  return readPaymentOpenUrl(orderId, now) !== null;
}

export function readPaymentOpenMeta(
  orderId: string,
  now: number = Date.now()
): PaymentOpenMeta | null {
  const stored = parseRecord(orderId, now);
  if (!stored) return null;
  return {
    returnTo: stored.returnTo ? safePaymentReturnTo(stored.returnTo) : null,
    replayContextId: stored.replay_context_id,
    createdAt: stored.created_at,
  };
}

export function clearPaymentOpen(orderId: string): void {
  removeSessionKey(storageKey(orderId));
}

export function clearPaymentOpenIfTerminal(
  orderId: string,
  status: 'pending' | 'completed' | 'expired' | 'failed'
): void {
  if (status === 'pending') return;
  clearPaymentOpen(orderId);
}

export function paymentOrderPagePath(
  orderId: string,
  options: { paymentStarted?: boolean; returnTo?: string | null; paymentReturned?: boolean } = {}
): string {
  const search = new URLSearchParams();
  if (options.paymentStarted) search.set('payment_started', '1');
  if (options.paymentReturned) search.set('payment', 'returned');
  const returnTo = options.returnTo ? safePaymentReturnTo(options.returnTo) : null;
  if (returnTo) search.set('returnTo', returnTo);
  const query = search.toString();
  return `/profile/recharge/${encodeURIComponent(orderId)}${query ? `?${query}` : ''}`;
}

/** 旧等待页把 pay_url 写在 query：迁入 sessionStorage 后立刻从地址栏拿掉。 */
export function adoptPayUrlQueryIntoStorage(
  orderId: string,
  payUrlFromQuery: string | null,
  returnTo: string | null,
  replayContextId: string | null
): void {
  if (!payUrlFromQuery || typeof window === 'undefined') return;
  persistPaymentOpen({
    orderId,
    payUrl: payUrlFromQuery,
    returnTo,
    replayContextId,
  });
  const url = new URL(window.location.href);
  if (!url.searchParams.has('pay_url')) return;
  url.searchParams.delete('pay_url');
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, '', next);
}
