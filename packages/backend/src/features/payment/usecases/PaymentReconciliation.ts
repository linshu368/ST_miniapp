import type {
  MiniappPaymentOrderRepository,
  MiniappPaymentOrderRow,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { PaymentGateway } from '../../../infrastructure/payment/PaymentGateway.js';
import { isEpayOrderId } from '../../../infrastructure/payment/epay-protocol.js';
import { SLOW_CALL_ERROR_CLASS, SLOW_CALL_MS } from '../domain/PaymentAlertRules.js';
import { settlePaidOrder, type SettlementLogger } from './PaymentSettlement.js';
import {
  recordPaymentOperationEvent,
  type PaymentEventRecorder,
} from './PaymentOperationEvents.js';

// The provider gives no expiry SLA. Retain seven days of bounded automatic recovery;
// older payments still recover via a verified callback or an explicit order query.
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECONCILE_LOOP_DELAY_MS = 30_000;
export const RECONCILE_MAX_CANDIDATES = 30;
export const RECONCILE_CONCURRENCY = 3;
export const RECONCILE_DISPATCH_BUDGET_MS = 25_000;

export type ReconcileTrigger = 'fast_reconcile' | 'expiry_reconcile';
export interface PaymentReconciliationResult {
  checked: number;
  settled: number;
  closed: number;
  lookupFailed: boolean;
}

type ReconcileOrders = Pick<
  MiniappPaymentOrderRepository,
  | 'listRecentUnsettled'
  | 'scheduleReconciliation'
  | 'expirePendingById'
  | 'findById'
  | 'complete'
  | 'reopenExpired'
  | 'attachProviderTransaction'
>;
interface ReconcileInput {
  orders: ReconcileOrders;
  gateway: Pick<PaymentGateway, 'queryOrder'>;
  log: SettlementLogger;
  /** Recovery stays enabled when new purchases are disabled but credentials remain configured. */
  paymentEnabled: boolean;
  trigger: ReconcileTrigger;
  now?: number;
  signal?: AbortSignal;
  events?: PaymentEventRecorder;
}

export async function runPaymentReconciliation(
  input: ReconcileInput
): Promise<PaymentReconciliationResult> {
  const result: PaymentReconciliationResult = {
    checked: 0,
    settled: 0,
    closed: 0,
    lookupFailed: false,
  };
  if (!input.paymentEnabled) return result;
  const now = input.now ?? Date.now();
  const signal = AbortSignal.any([
    AbortSignal.timeout(RECONCILE_DISPATCH_BUDGET_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  const candidates = await input.orders.listRecentUnsettled({
    since: new Date(now - RECONCILE_WINDOW_MS).toISOString(),
    now: new Date(now).toISOString(),
    limit: RECONCILE_MAX_CANDIDATES,
    signal,
  });
  const eligible = candidates
    .filter((order) => isEpayOrderId(order.id))
    .slice(0, RECONCILE_MAX_CANDIDATES);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < eligible.length && !signal.aborted) {
      const order = eligible[next++];
      if (!order) break;
      try {
        // Durable rotation avoids repeatedly spending the whole budget on the oldest slow orders.
        await input.orders.scheduleReconciliation(
          order.id,
          new Date((input.now ?? Date.now()) + RECONCILE_LOOP_DELAY_MS).toISOString(),
          signal
        );
        signal.throwIfAborted();
        result.checked += 1;
        await reconcileOrder(order, input, result, signal, now);
      } catch (err) {
        result.lookupFailed = true;
        input.log.sys.error(
          { event: 'payment.reconcile.order_failed', orderId: order.id, err },
          'Payment reconciliation failed; order remains recoverable'
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(RECONCILE_CONCURRENCY, eligible.length) }, worker)
  );
  if (signal.aborted || result.checked < eligible.length) result.lookupFailed = true;
  if (result.checked > 0 || result.lookupFailed) {
    input.log.biz.info(
      { event: 'payment.reconcile.completed', trigger: input.trigger, ...result },
      'Payment reconciliation completed'
    );
  }
  return result;
}

async function reconcileOrder(
  order: MiniappPaymentOrderRow,
  input: ReconcileInput,
  result: PaymentReconciliationResult,
  signal: AbortSignal,
  now: number
): Promise<void> {
  const startedAt = Date.now();
  const query = await input.gateway.queryOrder(order, signal);
  const elapsedMs = Date.now() - startedAt;
  recordPaymentOperationEvent(input.events, input.log, {
    event_key: `${input.trigger}:${order.id}:${startedAt}`,
    order_id: order.id,
    user_id: order.user_id,
    event_kind: input.trigger,
    stage: 'query',
    source: 'gateway',
    trigger: input.trigger,
    outcome: !query.success ? 'failed' : query.paid ? 'paid' : 'unpaid',
    error_class: !query.success
      ? (query.errorClass ?? 'response_invalid')
      : elapsedMs >= SLOW_CALL_MS
        ? SLOW_CALL_ERROR_CLASS
        : null,
    duration_ms: elapsedMs,
    occurred_at: new Date().toISOString(),
  });
  if (!query.success) {
    result.lookupFailed = true;
    return;
  }
  if (query.paid) {
    // Finish an already verified payment even if the dispatch deadline expires during settlement.
    const outcome = await settlePaidOrder(
      {
        orderId: order.id,
        paidAmount: query.amount,
        providerTransactionId: query.tradeNo ?? null,
      },
      input.orders,
      input.log,
      'cron',
      input.events
    );
    if (outcome === 'completed') result.settled += 1;
    else result.lookupFailed = true;
    return;
  }
  // Only a successfully queried unpaid order may get local UI expiry; never bulk-expire unknowns.
  if (
    !signal.aborted &&
    query.paid === false &&
    query.status === 'pending' &&
    order.status === 'pending' &&
    Date.parse(order.expires_at) <= now
  ) {
    if (await input.orders.expirePendingById(order.id)) result.closed += 1;
  }
}

export async function runPaymentReconciliationLoop(input: {
  runPass: () => Promise<PaymentReconciliationResult>;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onPass: (result: PaymentReconciliationResult) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      input.onPass(await input.runPass());
    } catch (error) {
      if (input.signal.aborted) return;
      input.onError(error);
    }
    if (input.signal.aborted) return;
    try {
      await input.sleep(RECONCILE_LOOP_DELAY_MS, input.signal);
    } catch (error) {
      if (input.signal.aborted) return;
      throw error;
    }
  }
}
