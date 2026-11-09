import type { EpayPaymentGateway } from '../../../infrastructure/payment/EpayPaymentGateway.js';
import type { MiniappPaymentOrderRepository } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { settlePaidOrder, type SettlementLogger } from './PaymentSettlement.js';
import {
  recordPaymentOperationEvent,
  type PaymentEventRecorder,
} from './PaymentOperationEvents.js';

interface NotificationDeps {
  gateway: Pick<EpayPaymentGateway, 'verifyNotification' | 'environment'>;
  orders: Pick<
    MiniappPaymentOrderRepository,
    'findById' | 'complete' | 'reopenExpired' | 'attachProviderTransaction'
  >;
  log: SettlementLogger;
  events?: PaymentEventRecorder;
}

export async function handleEpayNotification(
  rawQuery: string,
  deps: NotificationDeps
): Promise<{ status: number; body: string }> {
  const verification = deps.gateway.verifyNotification(rawQuery);
  if (!verification.ok) {
    record(deps, null, 'failed', verification.reason);
    deps.log.sys.warn(
      { event: 'payment.webhook.verify_failed', reason: verification.reason },
      '易支付通知验证失败'
    );
    return { status: verification.reason === 'invalid_body' ? 400 : 401, body: 'fail' };
  }
  const event = verification.event;
  if (event.param !== deps.gateway.environment) {
    record(deps, null, 'skipped', 'foreign_environment');
    return { status: 200, body: 'success' };
  }
  const orderId = event.out_trade_no;
  try {
    const order = await deps.orders.findById(orderId);
    if (!order) {
      record(deps, orderId, 'failed', 'order_not_found');
      return { status: 404, body: 'fail' };
    }
    if (
      order.payment_type !== event.type ||
      (order.provider_transaction_id && order.provider_transaction_id !== event.trade_no)
    ) {
      record(deps, orderId, 'failed', 'provider_ref_mismatch', true);
      return { status: 409, body: 'fail' };
    }
    if (event.trade_status !== 'TRADE_SUCCESS') {
      const refund = event.trade_status === 'TRADE_REFUND';
      const failed = event.trade_status === 'TRADE_ERROR';
      record(
        deps,
        orderId,
        refund ? 'failed' : failed ? 'unpaid' : 'skipped',
        refund ? 'refund' : failed ? 'provider_failed' : 'provider_unpaid'
      );
      return { status: 200, body: 'success' };
    }
    const result = await settlePaidOrder(
      {
        orderId,
        paidAmount: event.money,
        providerTransactionId: event.trade_no,
      },
      deps.orders,
      deps.log,
      'webhook',
      deps.events
    );
    record(
      deps,
      orderId,
      result === 'completed' ? 'succeeded' : 'failed',
      result === 'completed' ? null : result
    );
    return result === 'completed'
      ? { status: 200, body: 'success' }
      : { status: result === 'failed' ? 500 : 409, body: 'fail' };
  } catch (err) {
    deps.log.sys.error({ event: 'payment.webhook.failed', orderId, err }, '易支付通知处理失败');
    return { status: 500, body: 'fail' };
  }
}

function record(
  deps: NotificationDeps,
  orderId: string | null,
  outcome: 'failed' | 'skipped' | 'succeeded' | 'unpaid',
  errorClass: string | null,
  settlementAnomaly = false
): void {
  recordPaymentOperationEvent(deps.events, deps.log, {
    event_key: `epay:${outcome}:${errorClass ?? 'ok'}:${orderId ?? 'none'}:${Date.now()}`,
    order_id: orderId,
    user_id: null,
    event_kind: settlementAnomaly ? 'settlement' : 'webhook',
    stage: settlementAnomaly ? 'settlement' : 'callback',
    outcome,
    source: 'gateway',
    trigger: 'webhook',
    error_class: errorClass,
    occurred_at: new Date().toISOString(),
  });
}
