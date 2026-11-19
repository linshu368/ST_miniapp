import type { SettlementLogger } from './PaymentSettlement.js';
import { createHash } from 'node:crypto';
import { observation } from '../../../platform/observability/runtime.js';
import { safeBusinessFields } from '../../../platform/observability/business-context.js';
import { observationOutcome } from '../../../platform/observability/outcomes.js';
import type { PaymentOperationEventInput } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';

export type PaymentEventRecorder = Pick<
  import('../../../infrastructure/repositories/MiniappPaymentOrderRepository.js').MiniappPaymentOrderRepository,
  'recordOperationEvent'
>;

const RECOVERABLE_RECONCILE_ERRORS = new Set([
  'provider_unavailable',
  'network',
  'timeout',
  'rate_limited',
]);

export function isRecoverableReconcileError(errorClass: string | null | undefined): boolean {
  return typeof errorClass === 'string' && RECOVERABLE_RECONCILE_ERRORS.has(errorClass);
}

export function paymentOrderLogKey(orderId: string): string {
  return createHash('sha256').update(orderId).digest('hex').slice(0, 24);
}

/**
 * Payment events are deliberately best-effort. They provide monitoring evidence, never a
 * transaction boundary: a failed insert must not delay a checkout, query, or settlement.
 */
export function recordPaymentOperationEvent(
  recorder: PaymentEventRecorder | undefined,
  log: SettlementLogger,
  event: PaymentOperationEventInput,
  providerCode?: string
): void {
  const retryableQuery =
    (event.event_kind === 'fast_reconcile' || event.event_kind === 'expiry_reconcile') &&
    event.stage === 'query' &&
    event.outcome === 'failed' &&
    isRecoverableReconcileError(event.error_class);
  observation.emit(
    'payment.operation',
    `payment.${event.event_kind}`,
    {
      business_module: 'payment',
      ...safeBusinessFields({ user_id: event.user_id }),
      stage: event.stage,
      outcome:
        event.outcome === 'started'
          ? 'pending'
          : ['paid', 'unpaid'].includes(event.outcome)
            ? 'succeeded'
            : observationOutcome(event.outcome),
      outcome_known: event.outcome !== 'failed',
      error_code: event.error_class ?? undefined,
      // Provider messages and query URLs can contain secrets; only bounded numeric protocol codes are safe.
      code: providerCode && /^(?:HTTP_)?\d{1,3}$/.test(providerCode) ? providerCode : undefined,
      duration_ms: event.duration_ms ?? undefined,
      business_key: event.order_id ? paymentOrderLogKey(event.order_id) : undefined,
    },
    retryableQuery ? 'warn' : undefined
  );
  if (!recorder) return;
  void Promise.resolve()
    .then(() => recorder.recordOperationEvent(event))
    .catch((err: unknown) => {
      log.sys.error(
        {
          event: 'payment.operation_event.record_failed',
          err,
          eventKind: event.event_kind,
          stage: event.stage,
          outcome: event.outcome,
        },
        '支付操作旁路采集失败'
      );
    });
}
