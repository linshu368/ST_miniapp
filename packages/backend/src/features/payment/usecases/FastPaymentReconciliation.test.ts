import { describe, expect, it, vi } from 'vitest';

import type { MiniappPaymentOrderRow } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { PaymentQueryResult } from '../../../infrastructure/payment/ZqPaymentGateway.js';
import {
  FAST_RECONCILE_LOOP_DELAY_MS,
  runFastPaymentReconciliation,
  runFastPaymentReconciliationLoop,
  type FastPaymentReconciliationResult,
} from './FastPaymentReconciliation.js';
import type { SettlementLogger } from './PaymentSettlement.js';

vi.mock('../../../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));

const NOW = Date.parse('2026-08-27T10:00:00.000Z');

function createRow(overrides: Partial<MiniappPaymentOrderRow> = {}): MiniappPaymentOrderRow {
  return {
    id: 'MA-fast-1',
    user_id: '00000000-0000-0000-0000-000000000001',
    status: 'pending',
    payment_type: 'alipay',
    amount_cents: 600,
    credits_amount: 600,
    bonus_credits: 0,
    provider_transaction_id: null,
    credits_added: false,
    created_at: '2026-08-27T09:58:59.000Z',
    expires_at: '2026-08-27T10:13:59.000Z',
    paid_at: null,
    settled_by: null,
    next_reconcile_at: '2026-08-27T09:59:59.000Z',
    last_reconciled_at: null,
    reconcile_attempts: 0,
    reconcile_locked_until: null,
    ...overrides,
  };
}

function createOrders(candidates: MiniappPaymentOrderRow[]) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return {
    listDueForReconciliation: vi.fn(async () => candidates),
    claimForReconciliation: vi.fn(
      async (input: {
        candidate: MiniappPaymentOrderRow;
        now: string;
        lockedUntil: string;
      }): Promise<MiniappPaymentOrderRow | null> => ({
        ...input.candidate,
        last_reconciled_at: input.now,
        reconcile_attempts: input.candidate.reconcile_attempts + 1,
        reconcile_locked_until: input.lockedUntil,
      })
    ),
    releaseReconciliationClaim: vi.fn(async () => true),
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
    complete: vi.fn(async (id: string) => createRow({ id, status: 'completed' })),
    reopenExpired: vi.fn(async () => undefined),
  };
}

function createGateway(result: PaymentQueryResult) {
  return { queryOrder: vi.fn(async () => result) };
}

function createLog(): SettlementLogger {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { biz: sink, sys: sink } as unknown as SettlementLogger;
}

describe('runFastPaymentReconciliation', () => {
  it('does nothing when payment is disabled', async () => {
    const orders = createOrders([createRow()]);
    const gateway = createGateway({ success: true, paid: true, amount: '6.00' });

    const result = await runFastPaymentReconciliation({
      orders,
      gateway,
      log: createLog(),
      paymentEnabled: false,
      now: NOW,
    });

    expect(orders.listDueForReconciliation).not.toHaveBeenCalled();
    expect(gateway.queryOrder).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, claimed: 0, settled: 0, unpaid: 0, failed: 0 });
  });

  it('claims and settles a due paid order', async () => {
    const orders = createOrders([createRow()]);

    const result = await runFastPaymentReconciliation({
      orders,
      gateway: createGateway({
        success: true,
        paid: true,
        amount: '6.00',
        tradeNo: 'ZQ-fast-1',
      }),
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.listDueForReconciliation).toHaveBeenCalledWith({
      now: '2026-08-27T10:00:00.000Z',
      limit: 10,
    });
    expect(orders.complete).toHaveBeenCalledWith('MA-fast-1', 'ZQ-fast-1', 'cron');
    expect(orders.releaseReconciliationClaim).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, claimed: 1, settled: 1, unpaid: 0, failed: 0 });
  });

  it('reschedules an unpaid first attempt after two minutes', async () => {
    const orders = createOrders([createRow()]);

    const result = await runFastPaymentReconciliation({
      orders,
      gateway: createGateway({ success: true, paid: false }),
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.releaseReconciliationClaim).toHaveBeenCalledWith({
      id: 'MA-fast-1',
      lockedUntil: '2026-08-27T10:02:00.000Z',
      nextReconcileAt: '2026-08-27T10:02:00.000Z',
    });
    expect(result).toEqual({ checked: 1, claimed: 1, settled: 0, unpaid: 1, failed: 0 });
  });

  it('uses the five-minute backoff after the first attempt', async () => {
    const orders = createOrders([createRow({ reconcile_attempts: 1 })]);

    await runFastPaymentReconciliation({
      orders,
      gateway: createGateway({ success: false, errorMessage: 'gateway unavailable' }),
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.releaseReconciliationClaim).toHaveBeenCalledWith({
      id: 'MA-fast-1',
      lockedUntil: '2026-08-27T10:02:00.000Z',
      nextReconcileAt: '2026-08-27T10:05:00.000Z',
    });
  });

  it('releases the lease when the gateway throws', async () => {
    const orders = createOrders([createRow()]);
    const gateway = {
      queryOrder: vi.fn(async (): Promise<PaymentQueryResult> => {
        throw new Error('network down');
      }),
    };

    const result = await runFastPaymentReconciliation({
      orders,
      gateway,
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(orders.releaseReconciliationClaim).toHaveBeenCalledWith({
      id: 'MA-fast-1',
      lockedUntil: '2026-08-27T10:02:00.000Z',
      nextReconcileAt: '2026-08-27T10:02:00.000Z',
    });
    expect(result.failed).toBe(1);
  });

  it('does not query an order whose atomic claim was lost', async () => {
    const orders = createOrders([createRow()]);
    orders.claimForReconciliation.mockResolvedValueOnce(null);
    const gateway = createGateway({ success: true, paid: true, amount: '6.00' });

    const result = await runFastPaymentReconciliation({
      orders,
      gateway,
      log: createLog(),
      paymentEnabled: true,
      now: NOW,
    });

    expect(gateway.queryOrder).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, claimed: 0, settled: 0, unpaid: 0, failed: 0 });
  });
});

describe('runFastPaymentReconciliationLoop', () => {
  const empty: FastPaymentReconciliationResult = {
    checked: 0,
    claimed: 0,
    settled: 0,
    unpaid: 0,
    failed: 0,
  };

  it('sleeps 30 seconds after each pass until stopped', async () => {
    const controller = new AbortController();
    let passes = 0;
    const runPass = vi.fn(async () => {
      passes += 1;
      if (passes >= 2) controller.abort();
      return empty;
    });
    const sleep = vi.fn(async () => undefined);
    const onPass = vi.fn();
    const onError = vi.fn();

    await runFastPaymentReconciliationLoop({
      runPass,
      sleep,
      signal: controller.signal,
      onPass,
      onError,
    });

    expect(runPass).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(FAST_RECONCILE_LOOP_DELAY_MS, controller.signal);
    expect(onPass).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('finishes the current pass before stopping', async () => {
    const controller = new AbortController();
    const runPass = vi.fn(async () => {
      controller.abort();
      return empty;
    });
    const sleep = vi.fn(async () => undefined);
    const onPass = vi.fn();

    await runFastPaymentReconciliationLoop({
      runPass,
      sleep,
      signal: controller.signal,
      onPass,
      onError: vi.fn(),
    });

    expect(runPass).toHaveBeenCalledTimes(1);
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps looping after a pass error', async () => {
    const controller = new AbortController();
    let passes = 0;
    const runPass = vi.fn(async () => {
      passes += 1;
      if (passes === 1) throw new Error('gateway down');
      controller.abort();
      return empty;
    });
    const onError = vi.fn();

    await runFastPaymentReconciliationLoop({
      runPass,
      sleep: vi.fn(async () => undefined),
      signal: controller.signal,
      onPass: vi.fn(),
      onError,
    });

    expect(runPass).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
