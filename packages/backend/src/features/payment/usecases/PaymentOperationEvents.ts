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

/**
 * Payment events are deliberately best-effort. They provide monitoring evidence, never a
 * transaction boundary: a failed insert must not delay a checkout, query, or settlement.
 */
export function recordPaymentOperationEvent(
  recorder: PaymentEventRecorder | undefined,
  log: SettlementLogger,
  event: PaymentOperationEventInput
): void {
  observation.emit('payment.operation', `payment.${event.event_kind}`, {
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
    duration_ms: event.duration_ms ?? undefined,
    business_key: event.order_id
      ? createHash('sha256').update(event.order_id).digest('hex').slice(0, 24)
      : undefined,
  });
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
