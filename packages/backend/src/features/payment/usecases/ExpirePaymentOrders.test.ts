import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runExpirePaymentOrders } from './ExpirePaymentOrders.js';
import type { MiniappPaymentOrderRow } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { PaymentQueryResult } from '../../../infrastructure/payment/ZqPaymentGateway.js';
import type { SettlementLogger } from './PaymentSettlement.js';

vi.mock('../../../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));

const NOW = Date.parse('2026-08-21T12:00:00.000Z');

function createRow(overrides: Partial<MiniappPaymentOrderRow> = {}): MiniappPaymentOrderRow {
  return {
    id: 'MA-order-1',
    user_id: 'user-1',
    status: 'pending',
    payment_type: 'alipay',
    amount_cents: 600,
    credits_amount: 600,
    bonus_credits: 0,
    provider_transaction_id: null,
    credits_added: false,
    created_at: '2026-08-21T11:45:00.000Z',
    expires_at: '2026-08-21T11:59:00.000Z',
    paid_at: null,
    ...overrides,
  };
}

function createOrders(candidates: MiniappPaymentOrderRow[]) {
  const byId = new Map(candidates.map((row) => [row.id, row]));
  return {
    listUnsettledAroundExpiry: vi.fn(async () => candidates),
    expireAllPending: vi.fn(async () => candidates.length),
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
    complete: vi.fn(async (id: string) => createRow({ id, status: 'completed' })),
    reopenExpired: vi.fn(async () => undefined),
  };
}

function createLog(): SettlementLogger {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { biz: sink, sys: sink } as unknown as SettlementLogger;
}

function createGateway(results: Record<string, PaymentQueryResult>) {
  return {
    queryOrder: vi.fn(
      async (id: string) => results[id] ?? { success: true, paid: false as boolean }
    ),
  };
}

describe('runExpirePaymentOrders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries unsettled orders from the 24h lookback through newly created orders', async () => {
    const orders = createOrders([]);

    await runExpirePaymentOrders({
      orders,
      gateway: createGateway({}),
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.listUnsettledAroundExpiry).toHaveBeenCalledWith({
      since: '2026-08-20T12:00:00.000Z',
      until: '2026-08-21T12:15:00.000Z',
      limit: 100,
    });
  });

  it('credits a paid order before the expiry sweep runs', async () => {
    const row = createRow({ id: 'MA-cron-paid' });
    const orders = createOrders([row]);
    const gateway = createGateway({
      'MA-cron-paid': { success: true, paid: true, amount: '6.00', tradeNo: 'ZQ-1' },
    });

    const result = await runExpirePaymentOrders({
      orders,
      gateway,
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.complete).toHaveBeenCalledWith('MA-cron-paid', 'ZQ-1');
    expect(result.settled).toBe(1);

    // 顺序是这个任务的全部意义：反过来先判过期，钱收了而星尘不到账。
    const completedAt = orders.complete.mock.invocationCallOrder[0] ?? Infinity;
    const expiredAt = orders.expireAllPending.mock.invocationCallOrder[0] ?? 0;
    expect(completedAt).toBeLessThan(expiredAt);
  });

  it('leaves unpaid orders to the expiry sweep', async () => {
    const orders = createOrders([createRow({ id: 'MA-cron-unpaid' })]);

    const result = await runExpirePaymentOrders({
      orders,
      gateway: createGateway({ 'MA-cron-unpaid': { success: true, paid: false } }),
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.complete).not.toHaveBeenCalled();
    expect(orders.expireAllPending).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ checked: 1, settled: 0 });
  });

  it('recovers an already-expired order the vendor reports as paid', async () => {
    const orders = createOrders([
      createRow({ id: 'MA-cron-expired', status: 'expired', credits_added: false }),
    ]);

    const result = await runExpirePaymentOrders({
      orders,
      gateway: createGateway({
        'MA-cron-expired': { success: true, paid: true, amount: '6.00' },
      }),
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.reopenExpired).toHaveBeenCalledWith('MA-cron-expired');
    expect(result.settled).toBe(1);
  });

  it('keeps going when one order blows up mid-batch', async () => {
    const orders = createOrders([
      createRow({ id: 'MA-cron-boom' }),
      createRow({ id: 'MA-cron-ok' }),
    ]);
    const gateway = {
      queryOrder: vi.fn(async (id: string) => {
        if (id === 'MA-cron-boom') throw new Error('gateway exploded');
        return { success: true, paid: true, amount: '6.00' } satisfies PaymentQueryResult;
      }),
    };
    const log = createLog();

    const result = await runExpirePaymentOrders({
      orders,
      gateway,
      log,
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.complete).toHaveBeenCalledWith('MA-cron-ok', null);
    expect(result).toMatchObject({ checked: 2, settled: 1 });
    expect(orders.expireAllPending).toHaveBeenCalledOnce();
    expect(log.sys.error).toHaveBeenCalled();
  });

  it('still expires orders when payment is disabled, without querying the vendor', async () => {
    const orders = createOrders([createRow()]);
    const gateway = createGateway({});

    const result = await runExpirePaymentOrders({
      orders,
      gateway,
      log: createLog(),
      paymentEnabled: false,
      now: NOW,
    });

    expect(orders.listUnsettledAroundExpiry).not.toHaveBeenCalled();
    expect(gateway.queryOrder).not.toHaveBeenCalled();
    expect(orders.expireAllPending).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ checked: 0, settled: 0 });
  });
});
