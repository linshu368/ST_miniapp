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

import type { PaymentOrderStatus } from '@miniapp/shared';
import type { RequestLogger } from '../../../lib/logger.js';
import { insertUserNotification } from '../../../lib/notifications.js';
import type { MiniappPaymentOrderRepository } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { ZqPaymentGateway } from '../../../infrastructure/payment/ZqPaymentGateway.js';

/** 同时接受 requestLogger()（带 reqId，路由用）和 createLogger()（脚本用）。 */
export type SettlementLogger = Pick<RequestLogger, 'biz' | 'sys'>;

export type SettlementSource = 'webhook' | 'return' | 'query' | 'cron';

export type SettlementOutcome = 'completed' | 'order_not_found' | 'amount_mismatch' | 'failed';

type SettlementOrders = Pick<
  MiniappPaymentOrderRepository,
  'findById' | 'complete' | 'reopenExpired'
>;

/**
 * 已确认支付成功的订单入账。
 * 谁先确认由谁入账，重复由 complete_payment_order 的 credits_added 幂等兜住。
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

  // 确认迟于 15 分钟到达时订单已被判过期，但钱是真收了：先放回 pending 再入账，
  // 否则 complete_payment_order 会拒绝非 pending 订单，用户永久拿不到星尘。
  if (order.status === 'expired' && !order.credits_added) {
    await orders.reopenExpired(order.id);
    log.sys.warn(
      { event: 'payment.settle.expired_order_reopened', orderId: order.id, source },
      '已超时订单确认支付成功，恢复入账'
    );
  }

  try {
    await orders.complete(order.id, input.providerTransactionId);
    if (order.status !== 'completed') {
      try {
        const totalCredits = order.credits_amount + order.bonus_credits;
        await insertUserNotification({
          userId: order.user_id,
          category: 'system',
          title: '星尘充值到账',
          body: `订单 ${order.id} 已完成，${totalCredits} 星尘已到账。`,
        });
      } catch (notificationError) {
        log.sys.error(
          { event: 'payment.notification.failed', orderId: order.id, err: notificationError },
          '支付完成消息写入失败'
        );
      }
    }
    log.biz.info(
      {
        event: 'payment.settle.completed',
        orderId: order.id,
        source,
        amountCents: order.amount_cents,
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
