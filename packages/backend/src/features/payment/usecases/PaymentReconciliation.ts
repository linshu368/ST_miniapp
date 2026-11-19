import type {
  MiniappPaymentOrderRepository,
  MiniappPaymentOrderRow,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { PaymentGateway } from '../../../infrastructure/payment/PaymentGateway.js';
import { observation } from '../../../platform/observability/runtime.js';
import { finishBackgroundOperation, runObservedJob } from '../../../platform/observability/jobs.js';
import { isEpayOrderId } from '../../../infrastructure/payment/epay-protocol.js';
import { SLOW_CALL_ERROR_CLASS, SLOW_CALL_MS } from '../domain/PaymentAlertRules.js';
import { settlePaidOrder, type SettlementLogger } from './PaymentSettlement.js';
import {
  recordPaymentOperationEvent,
  isRecoverableReconcileError,
  paymentOrderLogKey,
  type PaymentEventRecorder,
} from './PaymentOperationEvents.js';

// Cap abandoned-order polling; later payments still recover through verified callbacks or explicit queries.
export const RECONCILE_WINDOW_MS = 8 * 60 * 60 * 1000;
export const RECONCILE_LOOP_DELAY_MS = 30_000;
// Per-order backoff applies to both failures and unpaid results, capped at two hours.
export const RECONCILE_BASE_DELAY_SECONDS = 30;
export const RECONCILE_MAX_DELAY_SECONDS = 2 * 60 * 60;
export const RECONCILE_MAX_CANDIDATES = 30;
export const RECONCILE_CONCURRENCY = 3;
export const RECONCILE_DISPATCH_BUDGET_MS = 25_000;

export type ReconcileTrigger = 'fast_reconcile' | 'expiry_reconcile';
export interface PaymentReconciliationResult {
  checked: number;
  settled: number;
  closed: number;
  lookupFailed: boolean;
  unpaidCount: number;
  failedCount: number;
  stoppedCount: number;
  skippedCount: number;
  criticalFailureCount: number;
  failureCounts: Record<string, number>;
}

type ReconcileOrders = Pick<
  MiniappPaymentOrderRepository,
  | 'claimDueReconciliations'
  | 'expirePendingById'
  | 'findById'
  | 'complete'
  | 'reopenExpired'
  | 'attachProviderTransaction'
  | 'recordReconcileUnpaid'
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
  return observation.observe(
    'payment.reconciliation',
    () => reconcileBatch(input),
    (result) => ({
      outcome: !input.paymentEnabled
        ? 'skipped'
        : result.criticalFailureCount
          ? 'failed'
          : result.lookupFailed
            ? 'degraded'
            : 'succeeded',
      outcome_known: !result.lookupFailed,
      count: result.checked,
    })
  );
}

async function reconcileBatch(input: ReconcileInput): Promise<PaymentReconciliationResult> {
  const result: PaymentReconciliationResult = {
    checked: 0,
    settled: 0,
    closed: 0,
    lookupFailed: false,
    unpaidCount: 0,
    failedCount: 0,
    stoppedCount: 0,
    skippedCount: 0,
    criticalFailureCount: 0,
    failureCounts: {},
  };
  if (!input.paymentEnabled) return result;
  const now = input.now ?? Date.now();
  const startedAt = Date.now();
  const signal = AbortSignal.any([
    AbortSignal.timeout(RECONCILE_DISPATCH_BUDGET_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  // Claiming schedules each order's next attempt first: a crash or timeout retries later, settlement is idempotent.
  const candidates = await input.orders.claimDueReconciliations({
    now: new Date(now).toISOString(),
    windowStart: new Date(now - RECONCILE_WINDOW_MS).toISOString(),
    limit: RECONCILE_MAX_CANDIDATES,
    baseDelaySeconds: RECONCILE_BASE_DELAY_SECONDS,
    maxDelaySeconds: RECONCILE_MAX_DELAY_SECONDS,
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
      // A claimed batch may wait behind other queries. Check age again immediately before dispatch.
      if (
        Date.parse(order.created_at) <
        now + Math.max(0, Date.now() - startedAt) - RECONCILE_WINDOW_MS
      ) {
        result.skippedCount += 1;
        continue;
      }
      try {
        signal.throwIfAborted();
        result.checked += 1;
        await reconcileOrder(order, input, result, signal, now);
      } catch (err) {
        if (signal.aborted && err === signal.reason) {
          result.lookupFailed = true;
          continue;
        }
        recordFailure(result, 'internal', true);
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
  if (signal.aborted || result.checked + result.skippedCount < eligible.length)
    result.lookupFailed = true;
  reportReconciliation(input, result);
  return result;
}

function recordFailure(result: PaymentReconciliationResult, errorClass: string, critical: boolean) {
  result.lookupFailed = true;
  result.failedCount += 1;
  if (critical) result.criticalFailureCount += 1;
  result.failureCounts[errorClass] = (result.failureCounts[errorClass] ?? 0) + 1;
}

function reportReconciliation(input: ReconcileInput, result: PaymentReconciliationResult) {
  if (result.checked === 0 && result.skippedCount === 0 && !result.lookupFailed) return;
  const level = result.criticalFailureCount ? 'error' : result.lookupFailed ? 'warn' : 'info';
  input.log.sys[level](
    {
      event: 'payment.reconciliation.summary',
      operation: 'payment.reconciliation',
      business_module: 'payment',
      trigger: input.trigger,
      outcome: result.criticalFailureCount
        ? 'failed'
        : result.lookupFailed
          ? 'degraded'
          : 'succeeded',
      outcome_known: !result.lookupFailed,
      checkedCount: result.checked,
      settledCount: result.settled,
      closedCount: result.closed,
      unpaidCount: result.unpaidCount,
      failedCount: result.failedCount,
      stoppedCount: result.stoppedCount,
      skippedCount: result.skippedCount,
      ...Object.fromEntries(
        Object.entries(result.failureCounts).map(([code, count]) => [`${code}Count`, count])
      ),
    },
    '支付订单对账结果'
  );
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
  const confirmedUnpaid = query.paid === false && query.status === 'pending';
  const queryFailed = !query.success || (query.paid !== true && !confirmedUnpaid);
  const elapsedMs = Date.now() - startedAt;
  recordPaymentOperationEvent(
    input.events,
    input.log,
    {
      event_key: `${input.trigger}:${order.id}:${startedAt}`,
      order_id: order.id,
      user_id: order.user_id,
      event_kind: input.trigger,
      stage: 'query',
      source: 'gateway',
      trigger: input.trigger,
      outcome: queryFailed ? 'failed' : query.paid ? 'paid' : 'unpaid',
      error_class: queryFailed
        ? (query.errorClass ?? 'response_invalid')
        : elapsedMs >= SLOW_CALL_MS
          ? SLOW_CALL_ERROR_CLASS
          : null,
      duration_ms: elapsedMs,
      occurred_at: new Date().toISOString(),
    },
    query.providerCode
  );
  if (queryFailed) {
    const errorClass = query.errorClass ?? 'response_invalid';
    recordFailure(result, errorClass, !isRecoverableReconcileError(errorClass));
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
    else recordFailure(result, 'settlement_failed', true);
    return;
  }
  if (query.paid !== false || query.status !== 'pending') return;
  result.unpaidCount += 1;
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
  if (!signal.aborted && Date.parse(order.expires_at) <= now) {
    const confirmation = await input.orders.recordReconcileUnpaid({
      orderId: order.id,
      claimedAt: new Date(now).toISOString(),
      signal,
    });
    if (confirmation.recorded && confirmation.stopped) {
      result.stoppedCount += 1;
      observation.emit('payment.reconcile.unpaid_limit_reached', 'payment.reconciliation', {
        business_module: 'payment',
        business_key: paymentOrderLogKey(order.id),
        outcome: 'skipped',
        count: confirmation.confirmations,
      });
    }
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
    // Keep result/error reporters in the round's context, not only the inner DB/payment calls.
    await runObservedJob('payment_reconciliation', async () => {
      try {
        const result = await input.runPass();
        input.onPass(result);
        finishBackgroundOperation('payment_reconciliation', {
          outcome: result.criticalFailureCount
            ? 'failed'
            : result.lookupFailed
              ? 'degraded'
              : 'succeeded',
          outcome_known: !result.lookupFailed,
        });
      } catch (error) {
        if (input.signal.aborted) {
          finishBackgroundOperation('payment_reconciliation', {
            outcome: 'cancelled',
            outcome_known: false,
          });
          return;
        }
        input.onError(error);
        finishBackgroundOperation('payment_reconciliation', {
          outcome: 'failed',
          outcome_known: false,
          err: error,
        });
      }
    });
    if (input.signal.aborted) return;
    try {
      await input.sleep(RECONCILE_LOOP_DELAY_MS, input.signal);
    } catch (error) {
      if (input.signal.aborted) return;
      throw error;
    }
  }
}
