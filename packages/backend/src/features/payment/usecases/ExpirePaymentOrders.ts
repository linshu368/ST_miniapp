/**
 * backend / features / payment / usecases / ExpirePaymentOrders.ts
 *
 * 定时任务主体：判过期之前先跟厂商对一次账。
 *
 * 厂商的异步通知不保证送达，用户付完款立刻关掉 MiniApp 时没有任何一方会触发查单，
 * 订单就会带着已收的钱挂到过期。顺序必须是「先查单补账、再判过期」——反过来会先把
 * 订单判死，钱收了而星尘不到账。
 */

import type { MiniappPaymentOrderRepository } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { ZqPaymentGateway } from '../../../infrastructure/payment/ZqPaymentGateway.js';
import { ORDER_EXPIRE_MS } from '../domain/rechargeRules.js';
import { reconcileWithGateway, type SettlementLogger } from './PaymentSettlement.js';

/** 回溯窗口：也覆盖上一轮 cron 已经判过期、但当时没查单的订单。 */
const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 单轮查单上限。查单是逐个串行的外部请求，别让一次 cron 跑成无界任务。 */
const RECONCILE_BATCH_SIZE = 100;
/** 至少积累这些样本后，才用失败率判断厂商查单是否健康。 */
const RECONCILE_FAILURE_MIN_SAMPLE_SIZE = 5;

export interface ExpirePaymentOrdersResult {
  checked: number;
  settled: number;
  expired: number;
}

export async function runExpirePaymentOrders(input: {
  orders: Pick<
    MiniappPaymentOrderRepository,
    'findById' | 'complete' | 'reopenExpired' | 'listUnsettledAroundExpiry' | 'expireAllPending'
  >;
  gateway: Pick<ZqPaymentGateway, 'queryOrder'>;
  log: SettlementLogger;
  paymentEnabled: boolean;
  now?: number;
}): Promise<ExpirePaymentOrdersResult> {
  const { orders, gateway, log, paymentEnabled } = input;
  const now = input.now ?? Date.now();

  let checked = 0;
  let settled = 0;
  let failed = 0;

  if (paymentEnabled) {
    const candidates = await orders.listUnsettledAroundExpiry({
      since: new Date(now - RECONCILE_WINDOW_MS).toISOString(),
      // expires_at = created_at + ORDER_EXPIRE_MS。把上界前推完整有效期，等价于新订单
      // 创建后立即进入查单候选，不再等到 15 分钟过期才进入兜底。
      until: new Date(now + ORDER_EXPIRE_MS).toISOString(),
      limit: RECONCILE_BATCH_SIZE,
    });
    checked = candidates.length;

    for (const candidate of candidates) {
      try {
        const monitoredGateway = {
          queryOrder: async (orderId: string) => {
            const result = await gateway.queryOrder(orderId);
            if (!result.success) failed += 1;
            return result;
          },
        };
        if (await reconcileWithGateway(candidate, monitoredGateway, orders, log, 'cron')) {
          settled += 1;
        }
      } catch (error) {
        failed += 1;
        // 单笔查不通不能拖垮整轮：后面的订单和判过期都还要跑。
        log.sys.error(
          { event: 'payment.cron.reconcile_failed', orderId: candidate.id, err: error },
          '判过期前查单失败'
        );
      }
    }

    if (checked > 0) {
      log.biz.info({ event: 'payment.cron.reconciled', checked, settled }, '判过期前对账完成');
    }
  }

  if (checked >= RECONCILE_FAILURE_MIN_SAMPLE_SIZE && failed * 2 > checked) {
    log.sys.error(
      {
        event: 'payment.cron.expiry_skipped',
        checked,
        failed,
        failureRate: failed / checked,
      },
      '查单失败率过高，跳过本轮订单过期'
    );
    return { checked, settled, expired: 0 };
  }

  const expired = await orders.expireAllPending();
  return { checked, settled, expired };
}
