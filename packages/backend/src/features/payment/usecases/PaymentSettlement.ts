/**
 * backend / features / payment / usecases / PaymentSettlement.ts
 *
 * 支付入账的唯一出口。四个入口共用这里：
 *   - 异步通知      routes/payment.ts  POST|GET /api/payment/webhook/zqpay
 *   - 同步回跳      routes/payment.ts  GET /api/payment/return
 *   - 前端轮询查单  routes/payment.ts  GET /api/payment/orders/:id
 *   - 判过期前查单  scripts/expire-payment-orders.ts
 *
 * 厂商的异步通知不保证送达（2026-08-21 实测有整条没推的订单），所以到账不能只挂在
 * 通知上；但多入口就必须共用一条幂等路径，否则会出现重复加星尘。
 */

import type { PaymentOrderStatus, PaymentSettlementSource } from '@miniapp/shared';
import type { RequestLogger } from '../../../lib/logger.js';
import { checkInviteFirstPaidReward } from '../../../lib/invite-rewards.js';
import { insertUserNotification } from '../../../lib/notifications.js';
import type {
  MiniappPaymentOrderRepository,
  MiniappPaymentOrderRow,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { ZqPaymentGateway } from '../../../infrastructure/payment/ZqPaymentGateway.js';
import { paymentSuccessNotice } from '../domain/paymentNotice.js';
import { observePaymentOrderSettled } from './PaymentOrderTelemetry.js';

/** 同时接受 requestLogger()（带 reqId，路由用）和 createLogger()（脚本用）。 */
export type SettlementLogger = Pick<RequestLogger, 'biz' | 'sys'>;

export type SettlementSource = PaymentSettlementSource;

export type SettlementOutcome = 'completed' | 'order_not_found' | 'amount_mismatch' | 'failed';

type SettlementOrders = Pick<
  MiniappPaymentOrderRepository,
  'findById' | 'complete' | 'reopenExpired'
>;

/** credits 历史行在回填前仍认 credits_added；VIP 只认 fulfillment_applied。 */
export function isOrderFulfilled(
  order: Pick<MiniappPaymentOrderRow, 'product_type' | 'credits_added' | 'fulfillment_applied'>
): boolean {
  if (order.fulfillment_applied) return true;
  return order.product_type !== 'vip' && order.credits_added;
}

/**
 * 已确认支付成功的订单入账。
 * 谁先确认由谁入账。重复履约由数据库订单锁和 fulfillment_applied 兜住。
 * 邀请是否算首次现金支付由数据库判定：已履约订单认 fulfillment_applied，
 * credits 历史行在回填前仍认 credits_added。同一订单重放由邀请日志去重。
 */
export async function settlePaidOrder(
  input: {
    orderId: string;
    paidAmount: string | undefined;
    providerTransactionId: string | null;
  },
  orders: SettlementOrders,
  log: SettlementLogger,
  source: SettlementSource
): Promise<SettlementOutcome> {
  const { orderId } = input;
  const order = await orders.findById(orderId);
  if (!order) {
    log.sys.warn({ event: 'payment.settle.order_not_found', orderId, source }, '支付订单不存在');
    return 'order_not_found';
  }

  const paidAmountCents = parseAmountCents(input.paidAmount);
  if (paidAmountCents !== order.amount_cents) {
    log.sys.warn(
      {
        event: 'payment.settle.amount_mismatch',
        orderId,
        source,
        expected: order.amount_cents,
        actual: paidAmountCents,
      },
      '支付金额与订单金额不匹配'
    );
    return 'amount_mismatch';
  }

  // 确认迟于过期任务时订单已是 expired，但钱是真收了：先放回 pending 再履约。
  // VIP 已履约订单的 credits_added 仍是 false，必须同时看 fulfillment_applied。
  if (order.status === 'expired' && !isOrderFulfilled(order)) {
    await orders.reopenExpired(order.id);
    log.sys.warn(
      { event: 'payment.settle.expired_order_reopened', orderId: order.id, source },
      '已超时订单确认支付成功，恢复入账'
    );
  }

  const started = Date.now();
  try {
    const completed = await orders.complete(order.id, input.providerTransactionId, source);
    // 终态事件是非关键观测：必须在 complete 成功之后触发，且不得 delay/回滚入账。
    try {
      void observePaymentOrderSettled(
        {
          orderId: completed.id,
          userId: order.user_id,
          paymentType: order.payment_type,
          settledBy: completed.settled_by,
        },
        log
      );
    } catch (telemetryError) {
      log.sys.error(
        { event: 'payment.telemetry.failed', err: telemetryError, orderId: order.id },
        '支付终态事件发送失败'
      );
    }
    if (order.status !== 'completed') {
      try {
        const notice = paymentSuccessNotice(order);
        await insertUserNotification({
          userId: order.user_id,
          category: 'system',
          title: notice.title,
          body: notice.body,
        });
      } catch (notificationError) {
        log.sys.error(
          { event: 'payment.notification.failed', orderId: order.id, err: notificationError },
          '支付完成消息写入失败'
        );
      }
    }

    // 裂变「被邀请人首次付费」奖励。挂在这里而不是各入口，是因为四条入账路径都收敛到本函数。
    // 不按 order.status 跳过重放：判定 RPC 自带幂等，重放反而给上一次失败的判定一次重试机会。
    await checkInviteFirstPaidReward({ userId: order.user_id, orderId: order.id }, log);

    log.biz.info(
      {
        event: 'payment.settle.completed',
        orderId: order.id,
        userId: order.user_id,
        source,
        productType: order.product_type,
        planId: order.product_id,
        amountCents: order.amount_cents,
        fulfillmentApplied: completed.fulfillment_applied,
        vipValidUntilBefore: order.vip_valid_until,
        vipValidUntilAfter: completed.vip_valid_until,
        durationMs: Date.now() - started,
      },
      '支付订单完成'
    );
    return 'completed';
  } catch (error) {
    log.sys.error(
      { event: 'payment.settle.failed', err: error, orderId: order.id, source },
      '支付订单完成处理失败'
    );
    return 'failed';
  }
}

/** 同一订单的查单最小间隔。前端每 2 秒轮询一次订单详情，不节流会把查单打成 2 秒一发。 */
const QUERY_MIN_INTERVAL_MS = 5_000;
const lastQueryAt = new Map<string, number>();

/**
 * 对未到账的订单主动查一次厂商单据，确认已支付就入账。
 * 返回是否发生了状态变化，调用方据此决定要不要重读订单。
 */
export async function reconcileWithGateway(
  order: { id: string; status: PaymentOrderStatus },
  gateway: Pick<ZqPaymentGateway, 'queryOrder'>,
  orders: SettlementOrders,
  log: SettlementLogger,
  source: SettlementSource = 'query'
): Promise<boolean> {
  const settleable = order.status === 'pending' || order.status === 'expired';
  if (!settleable) return false;

  const now = Date.now();
  const previous = lastQueryAt.get(order.id);
  if (previous !== undefined && now - previous < QUERY_MIN_INTERVAL_MS) return false;
  if (lastQueryAt.size > 1_000) {
    for (const [key, at] of lastQueryAt) {
      if (now - at > 60 * 60 * 1000) lastQueryAt.delete(key);
    }
  }
  lastQueryAt.set(order.id, now);

  const result = await gateway.queryOrder(order.id);
  if (!result.success) {
    log.sys.warn(
      { event: 'payment.query.failed', orderId: order.id, source, reason: result.errorMessage },
      '主动查单失败'
    );
    return false;
  }
  if (!result.paid) return false;

  log.biz.info(
    { event: 'payment.query.paid', orderId: order.id, source },
    '主动查单发现订单已支付'
  );
  const settlement = await settlePaidOrder(
    {
      orderId: order.id,
      paidAmount: result.amount,
      providerTransactionId: result.tradeNo ?? null,
    },
    orders,
    log,
    source
  );
  return settlement === 'completed';
}

/** 厂商金额是「元」字符串，本地订单是「分」整数。非法格式返回 NaN，让金额校验必然失败。 */
export function parseAmountCents(amount: string | undefined): number {
  if (!amount || !/^\d+(?:\.\d{1,2})?$/.test(amount)) return NaN;
  const [yuan = '0', fraction = ''] = amount.split('.');
  return Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
}
