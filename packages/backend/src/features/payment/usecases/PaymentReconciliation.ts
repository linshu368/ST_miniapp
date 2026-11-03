/**
 * backend / features / payment / usecases / PaymentReconciliation.ts
 *
 * 对账任务主体：一次批量查单拿回最近订单的平台真实状态。
 *   - 30 秒常驻 worker（scripts/reconcile-payment-orders.ts）：查单补账。
 *   - 5 分钟 cron（scripts/expire-payment-orders.ts）：同一轮查单补账之后再判过期。
 *
 * 顺序必须是「先查单补账、再判过期」，反过来会先把订单判死、钱收了而权益不到账。
 * 平台每笔都给明确状态，所以这里不再需要逐单领取、租约和退避：每轮一个请求，结算本身幂等。
 */

import type {
  MiniappPaymentOrderRepository,
  MiniappPaymentOrderRow,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import {
  LOOKUP_BATCH_SIZE,
  type PaymentLookupGateway,
  type PaymentLookupItem,
} from '../../../infrastructure/payment/VexutopiaPaymentGateway.js';
import { settlePaidOrder, type SettlementLogger } from './PaymentSettlement.js';
import {
  recordPaymentOperationEvent,
  type PaymentEventRecorder,
} from './PaymentOperationEvents.js';

/** 支付宝/微信收银台实测 30 分钟过期（文档写 1 小时）；窗口取 2 小时，覆盖“本地已判过期、用户在收银台晚付”的订单。 */
export const RECONCILE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 单轮候选上限。月流水量级下一轮远到不了；超出时最早的订单先查，剩下的下一轮再查。 */
const MAX_CANDIDATES = 300;
/** 常驻 worker 每轮间隔。Railway cron 最短 5 分钟，分钟级到账兜底只能靠进程内循环。 */
export const RECONCILE_LOOP_DELAY_MS = 30 * 1000;

/** 平台判定的未支付终态。refunded 出现在未履约订单上同样不应再入账。 */
const PROVIDER_UNPAID_TERMINAL = new Set([
  'failed',
  'expired',
  'cancelled',
  'refunded',
  'partially_refunded',
]);

export type ReconcileTrigger = 'fast_reconcile' | 'expiry_reconcile';

export interface PaymentReconciliationResult {
  checked: number;
  settled: number;
  /** 平台判定未支付终态、本轮被提前关单的订单数。 */
  closed: number;
  /** 至少一批查单失败。判过期任务据此跳过本轮，避免在不知道平台状态时关单。 */
  lookupFailed: boolean;
}

type ReconcileOrders = Pick<
  MiniappPaymentOrderRepository,
  'listRecentUnsettled' | 'expirePendingById' | 'findById' | 'complete' | 'reopenExpired'
>;

export async function runPaymentReconciliation(input: {
  orders: ReconcileOrders;
  gateway: PaymentLookupGateway;
  log: SettlementLogger;
  paymentEnabled: boolean;
  trigger: ReconcileTrigger;
  now?: number;
  events?: PaymentEventRecorder;
}): Promise<PaymentReconciliationResult> {
  const result: PaymentReconciliationResult = {
    checked: 0,
    settled: 0,
    closed: 0,
    lookupFailed: false,
  };
  if (!input.paymentEnabled) return result;

  const now = input.now ?? Date.now();
  const candidates = await input.orders.listRecentUnsettled({
    since: new Date(now - RECONCILE_WINDOW_MS).toISOString(),
    limit: MAX_CANDIDATES,
  });
  result.checked = candidates.length;

  for (let offset = 0; offset < candidates.length; offset += LOOKUP_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + LOOKUP_BATCH_SIZE);
    const byTransaction = new Map(
      batch.flatMap((order) =>
        order.provider_transaction_id ? [[order.provider_transaction_id, order] as const] : []
      )
    );
    const startedAt = Date.now();
    const lookup = await input.gateway.lookupPayments([...byTransaction.keys()]);
    if (!lookup.success) {
      result.lookupFailed = true;
      input.log.sys.warn(
        {
          event: 'payment.reconcile.lookup_failed',
          trigger: input.trigger,
          batchSize: batch.length,
          errorClass: lookup.errorClass,
          providerCode: lookup.providerCode,
        },
        '批量查单失败'
      );
      recordPaymentOperationEvent(input.events, input.log, {
        event_key: `${input.trigger}:lookup_failed:${startedAt}:${offset}`,
        order_id: null,
        user_id: null,
        event_kind: input.trigger,
        stage: 'query',
        outcome: 'failed',
        source: 'cron',
        trigger: input.trigger,
        error_class: lookup.errorClass,
        duration_ms: Date.now() - startedAt,
        occurred_at: new Date().toISOString(),
        metadata: { batch_size: batch.length },
      });
      continue;
    }

    for (const item of lookup.items) {
      const order = byTransaction.get(item.transactionId);
      if (!order) continue;
      try {
        await applyLookupItem(order, item, input, result);
      } catch (error) {
        // 单笔处理失败不能拖垮整批：后面的订单和判过期都还要跑。
        input.log.sys.error(
          { event: 'payment.reconcile.order_failed', orderId: order.id, err: error },
          '对账处理单笔订单失败'
        );
      }
    }
  }

  if (result.checked > 0) {
    input.log.biz.info(
      { event: 'payment.reconcile.completed', trigger: input.trigger, ...result },
      '支付订单对账完成'
    );
  }
  return result;
}

async function applyLookupItem(
  order: MiniappPaymentOrderRow,
  item: PaymentLookupItem,
  input: {
    orders: ReconcileOrders;
    log: SettlementLogger;
    trigger: ReconcileTrigger;
    events?: PaymentEventRecorder;
  },
  result: PaymentReconciliationResult
): Promise<void> {
  // 同一异常每轮都会看到；事件键不带时间，事件表按键去重只记一次。
  const anomaly = (errorClass: string) => {
    input.log.sys.warn(
      { event: 'payment.reconcile.anomaly', orderId: order.id, errorClass },
      '对账发现平台单据异常'
    );
    recordPaymentOperationEvent(input.events, input.log, {
      ...reconcileEvent(order, input.trigger, 'failed', errorClass),
      event_key: `${input.trigger}:${errorClass}:${order.id}`,
    });
  };

  if (!item.found) return anomaly('provider_not_found');
  if (item.orderId !== undefined && item.orderId !== order.id) {
    return anomaly('provider_ref_mismatch');
  }

  if (item.status === 'completed') {
    if (item.currency !== 'CNY') return anomaly('currency_mismatch');
    recordPaymentOperationEvent(
      input.events,
      input.log,
      reconcileEvent(order, input.trigger, 'paid', null)
    );
    const settlement = await settlePaidOrder(
      {
        orderId: order.id,
        paidAmount: item.amount,
        providerTransactionId: item.transactionId,
      },
      input.orders,
      input.log,
      'cron',
      input.events
    );
    if (settlement === 'completed') result.settled += 1;
    return;
  }

  if (item.status && PROVIDER_UNPAID_TERMINAL.has(item.status) && order.status === 'pending') {
    if (await input.orders.expirePendingById(order.id)) {
      result.closed += 1;
      recordPaymentOperationEvent(
        input.events,
        input.log,
        reconcileEvent(order, input.trigger, 'unpaid', `provider_${item.status}`)
      );
    }
  }
  // pending：用户还没付或平台还在确认，不记事件，避免每 30 秒刷一次事件表。
}

function reconcileEvent(
  order: MiniappPaymentOrderRow,
  trigger: ReconcileTrigger,
  outcome: 'paid' | 'unpaid' | 'failed',
  errorClass: string | null
) {
  return {
    event_key: `${trigger}:${outcome}:${order.id}:${Date.now()}`,
    order_id: order.id,
    user_id: order.user_id,
    event_kind: trigger,
    stage: 'query' as const,
    outcome,
    source: 'cron' as const,
    trigger,
    error_class: errorClass,
    occurred_at: new Date().toISOString(),
  };
}

/** 常驻 worker 的循环：每轮失败只记录，不退出；收到停止信号后跑完本轮再退。 */
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
