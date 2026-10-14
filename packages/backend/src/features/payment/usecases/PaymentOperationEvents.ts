import type { SettlementLogger } from './PaymentSettlement.js';
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
