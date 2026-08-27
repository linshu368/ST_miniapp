import type {
  MiniappPaymentOrderRepository,
  MiniappPaymentOrderRow,
} from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { ZqPaymentGateway } from '../../../infrastructure/payment/ZqPaymentGateway.js';
import { settlePaidOrder, type SettlementLogger } from './PaymentSettlement.js';

const RECONCILE_BATCH_SIZE = 10;
const RECONCILE_CONCURRENCY = 5;
const RECONCILE_LEASE_MS = 2 * 60 * 1000;
const SECOND_RECONCILE_DELAY_MS = 30 * 1000;
const SECOND_ATTEMPT_DELAY_MS = 2 * 60 * 1000;
const LATER_ATTEMPT_DELAY_MS = 5 * 60 * 1000;

export interface FastPaymentReconciliationResult {
  checked: number;
  claimed: number;
  settled: number;
  unpaid: number;
  failed: number;
}

type FastReconciliationOrders = Pick<
  MiniappPaymentOrderRepository,
  | 'findById'
  | 'complete'
  | 'reopenExpired'
  | 'listDueForReconciliation'
  | 'claimForReconciliation'
  | 'releaseReconciliationClaim'
>;

export async function runFastPaymentReconciliation(input: {
  orders: FastReconciliationOrders;
  gateway: Pick<ZqPaymentGateway, 'queryOrder'>;
  log: SettlementLogger;
  paymentEnabled: boolean;
  now?: number;
}): Promise<FastPaymentReconciliationResult> {
  const result: FastPaymentReconciliationResult = {
    checked: 0,
    claimed: 0,
    settled: 0,
    unpaid: 0,
    failed: 0,
  };
  if (!input.paymentEnabled) return result;

  const now = input.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const lockedUntil = new Date(now + RECONCILE_LEASE_MS).toISOString();
  const candidates = await input.orders.listDueForReconciliation({
    now: nowIso,
    limit: RECONCILE_BATCH_SIZE,
  });
  result.checked = candidates.length;

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(RECONCILE_CONCURRENCY, candidates.length) },
    async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor];
        cursor += 1;
        if (candidate) {
          await reconcileCandidate(candidate, lockedUntil, now, input, result);
        }
      }
    }
  );
  await Promise.all(workers);

  if (result.checked > 0) {
    input.log.biz.info(
      { event: 'payment.fast_cron.reconciled', ...result },
      '支付订单快速对账完成'
    );
  }
  return result;
}

async function reconcileCandidate(
  candidate: MiniappPaymentOrderRow,
  lockedUntil: string,
  now: number,
  input: {
    orders: FastReconciliationOrders;
    gateway: Pick<ZqPaymentGateway, 'queryOrder'>;
    log: SettlementLogger;
  },
  result: FastPaymentReconciliationResult
): Promise<void> {
  let claimed: MiniappPaymentOrderRow | null = null;
  let shouldReleaseOnError = true;
  try {
    claimed = await input.orders.claimForReconciliation({
      candidate,
      now: new Date(now).toISOString(),
      lockedUntil,
    });
    if (!claimed) return;
    result.claimed += 1;

    const query = await input.gateway.queryOrder(claimed.id);
    if (!query.success) {
      input.log.sys.warn(
        {
          event: 'payment.query.failed',
          orderId: claimed.id,
          source: 'cron',
          reason: query.errorMessage,
        },
        '快速对账查单失败'
      );
      shouldReleaseOnError = false;
      await releaseForRetry(claimed, lockedUntil, now, input);
      result.failed += 1;
      return;
    }

    if (!query.paid) {
      result.unpaid += 1;
      input.log.biz.info(
        { event: 'payment.query.unpaid', orderId: claimed.id, source: 'cron' },
        '快速对账确认订单未支付'
      );
      shouldReleaseOnError = false;
      await releaseForRetry(claimed, lockedUntil, now, input);
      return;
    }

    input.log.biz.info(
      { event: 'payment.query.paid', orderId: claimed.id, source: 'cron' },
      '快速对账发现订单已支付'
    );
    const settlement = await settlePaidOrder(
      {
        orderId: claimed.id,
        paidAmount: query.amount,
        providerTransactionId: query.tradeNo ?? null,
      },
      input.orders,
      input.log,
      'cron'
    );
    if (settlement === 'completed') {
      result.settled += 1;
      return;
    }

    shouldReleaseOnError = false;
    await releaseForRetry(claimed, lockedUntil, now, input);
    result.failed += 1;
  } catch (error) {
    result.failed += 1;
    input.log.sys.error(
      { event: 'payment.fast_cron.reconcile_failed', orderId: candidate.id, err: error },
      '支付订单快速对账失败'
    );
    if (claimed && shouldReleaseOnError) {
      try {
        await releaseForRetry(claimed, lockedUntil, now, input);
      } catch (releaseError) {
        input.log.sys.error(
          {
            event: 'payment.fast_cron.release_failed',
            orderId: candidate.id,
            err: releaseError,
          },
          '支付订单快速对账租约释放失败'
        );
      }
    }
  }
}

async function releaseForRetry(
  claimed: MiniappPaymentOrderRow,
  lockedUntil: string,
  now: number,
  input: { orders: FastReconciliationOrders }
): Promise<void> {
  const delay = claimed.reconcile_attempts <= 1 ? SECOND_ATTEMPT_DELAY_MS : LATER_ATTEMPT_DELAY_MS;
  await input.orders.releaseReconciliationClaim({
    id: claimed.id,
    lockedUntil,
    nextReconcileAt: new Date(now + delay).toISOString(),
  });
}

export async function runDualPassFastPaymentReconciliation(input: {
  runPass: () => Promise<FastPaymentReconciliationResult>;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<FastPaymentReconciliationResult> {
  const now = input.now ?? Date.now;
  const firstStartedAt = now();
  const first = await input.runPass();
  await input.sleep(Math.max(0, firstStartedAt + SECOND_RECONCILE_DELAY_MS - now()));
  const second = await input.runPass();

  return {
    checked: first.checked + second.checked,
    claimed: first.claimed + second.claimed,
    settled: first.settled + second.settled,
    unpaid: first.unpaid + second.unpaid,
    failed: first.failed + second.failed,
  };
}
