import type { PaymentOrderStatus } from '@miniapp/shared';

export const PAYMENT_ATTEMPT_GAP_MS = 15 * 60 * 1000;
export interface PaymentAlertOrderSnapshot {
  orderId: string;
  userId: string;
  checkoutConfirmedAt: string | null;
  status: PaymentOrderStatus;
  paidAt: string | null;
  fulfillmentApplied: boolean;
  settledBy?: string | null;
}
export interface PaymentAttempt {
  userId: string;
  startedAt: string;
  lastConfirmedAt: string;
  orderIds: string[];
  hasCompletedOrder: boolean;
  hasExpiredOrder: boolean;
  hasPendingOrder: boolean;
}
export interface PaymentAttemptAggregation {
  attempts: PaymentAttempt[];
  excludedOrderIds: string[];
}
export interface PaymentAttemptSummary {
  attempts: number;
  affectedUsers: number;
  successfulAttempts: number;
  suspectedFailedAttempts: number;
  longPendingAttempts: number;
}
interface ParsedOrder extends PaymentAlertOrderSnapshot {
  checkoutConfirmedAtMs: number;
}

/** Confirmation time, rather than order creation, is the only attempt clock. */
export function aggregatePaymentAttempts(
  orders: readonly PaymentAlertOrderSnapshot[],
  gapMs = PAYMENT_ATTEMPT_GAP_MS
): PaymentAttemptAggregation {
  if (!Number.isFinite(gapMs) || gapMs < 0)
    throw new Error('payment attempt gap must be a nonnegative finite number');
  const excludedOrderIds: string[] = [];
  const valid: ParsedOrder[] = [];
  for (const order of orders) {
    const ms = parseTrustedTimestamp(order.checkoutConfirmedAt);
    if (!order.userId || ms === null) excludedOrderIds.push(order.orderId);
    else valid.push({ ...order, checkoutConfirmedAtMs: ms });
  }
  valid.sort(
    (a, b) =>
      a.userId.localeCompare(b.userId) ||
      a.checkoutConfirmedAtMs - b.checkoutConfirmedAtMs ||
      a.orderId.localeCompare(b.orderId)
  );
  const attempts: PaymentAttempt[] = [];
  for (const order of valid) {
    const previous = attempts.at(-1);
    if (
      !previous ||
      previous.userId !== order.userId ||
      order.checkoutConfirmedAtMs - Date.parse(previous.lastConfirmedAt) > gapMs
    ) {
      attempts.push(createAttempt(order));
      continue;
    }
    previous.lastConfirmedAt = order.checkoutConfirmedAt!;
    previous.orderIds.push(order.orderId);
    previous.hasCompletedOrder ||= completed(order);
    previous.hasExpiredOrder ||= order.status === 'expired';
    previous.hasPendingOrder ||= order.status === 'pending';
  }
  return { attempts, excludedOrderIds };
}
export function summarizePaymentAttempts(
  attempts: readonly PaymentAttempt[],
  nowMs: number,
  longPendingAfterMs: number
): PaymentAttemptSummary {
  if (!Number.isFinite(nowMs) || !Number.isFinite(longPendingAfterMs) || longPendingAfterMs < 0)
    throw new Error('payment attempt summary requires finite nonnegative timing inputs');
  let successfulAttempts = 0,
    suspectedFailedAttempts = 0,
    longPendingAttempts = 0;
  const users = new Set<string>();
  for (const attempt of attempts) {
    users.add(attempt.userId);
    if (attempt.hasCompletedOrder) {
      successfulAttempts++;
      continue;
    }
    if (attempt.hasExpiredOrder) suspectedFailedAttempts++;
    if (attempt.hasPendingOrder && nowMs - Date.parse(attempt.startedAt) > longPendingAfterMs)
      longPendingAttempts++;
  }
  return {
    attempts: attempts.length,
    affectedUsers: users.size,
    successfulAttempts,
    suspectedFailedAttempts,
    longPendingAttempts,
  };
}
function createAttempt(order: ParsedOrder): PaymentAttempt {
  return {
    userId: order.userId,
    startedAt: order.checkoutConfirmedAt!,
    lastConfirmedAt: order.checkoutConfirmedAt!,
    orderIds: [order.orderId],
    hasCompletedOrder: completed(order),
    hasExpiredOrder: order.status === 'expired',
    hasPendingOrder: order.status === 'pending',
  };
}
function completed(order: PaymentAlertOrderSnapshot): boolean {
  return order.status === 'completed' && order.fulfillmentApplied && order.paidAt !== null;
}
function parseTrustedTimestamp(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
