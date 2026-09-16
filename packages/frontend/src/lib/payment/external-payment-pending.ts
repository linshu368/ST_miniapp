import type { PaymentType } from '@miniapp/shared';

import { readSessionJson, removeSessionKey, writeSessionJson } from './session-storage';

export const EXTERNAL_PAYMENT_PENDING_TTL_MS = 30 * 60 * 1000;
const PENDING_KEY = 'st.replay.external_payment_pending';
const OBSERVED_KEY = 'st.replay.payment_return_observed';
const UNKNOWN_ORDER_ID = '__unknown__';

export type ExternalPaymentPending = {
  orderId: string;
  paymentType: PaymentType | undefined;
  replayContextId: string | null;
  openedAt: number;
};

type StoredPending = {
  orderId?: unknown;
  paymentType?: unknown;
  replayContextId?: unknown;
  openedAt?: unknown;
};

type StoredObserved = {
  orderIds?: unknown;
};

function isPaymentType(value: unknown): value is PaymentType {
  return value === 'wxpay' || value === 'alipay';
}

function isOrderId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 128;
}

export function observedOrderKey(orderId: string | null): string {
  return orderId ?? UNKNOWN_ORDER_ID;
}

export function writeExternalPaymentPending(record: ExternalPaymentPending): boolean {
  return writeSessionJson(PENDING_KEY, {
    orderId: record.orderId,
    paymentType: record.paymentType,
    replayContextId: record.replayContextId,
    openedAt: record.openedAt,
  });
}

export function readExternalPaymentPending(
  now: number = Date.now()
): ExternalPaymentPending | null {
  const stored = readSessionJson<StoredPending>(PENDING_KEY);
  if (!stored || !isOrderId(stored.orderId) || typeof stored.openedAt !== 'number') {
    return null;
  }
  if (now - stored.openedAt > EXTERNAL_PAYMENT_PENDING_TTL_MS) {
    removeSessionKey(PENDING_KEY);
    return null;
  }
  return {
    orderId: stored.orderId.trim(),
    paymentType: isPaymentType(stored.paymentType) ? stored.paymentType : undefined,
    replayContextId: typeof stored.replayContextId === 'string' ? stored.replayContextId : null,
    openedAt: stored.openedAt,
  };
}

export function clearExternalPaymentPending(): void {
  removeSessionKey(PENDING_KEY);
}

export function readObservedReturnOrderIds(): Set<string> {
  const stored = readSessionJson<StoredObserved>(OBSERVED_KEY);
  if (!stored || !Array.isArray(stored.orderIds)) return new Set();
  return new Set(stored.orderIds.filter((item): item is string => typeof item === 'string'));
}

export function persistObservedReturnOrderId(orderId: string | null): void {
  const orderIds = readObservedReturnOrderIds();
  orderIds.add(observedOrderKey(orderId));
  writeSessionJson(OBSERVED_KEY, { orderIds: [...orderIds] });
}

export function clearObservedReturnOrderIdsForTests(): void {
  removeSessionKey(OBSERVED_KEY);
}
