import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MiniappPaymentOrderRow } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type {
  PaymentLookupItem,
  PaymentLookupResult,
} from '../../../infrastructure/payment/VexutopiaPaymentGateway.js';
import { RECONCILE_WINDOW_MS, runPaymentReconciliation } from './PaymentReconciliation.js';

vi.mock('../../../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/invite-rewards.js', () => ({
  checkInviteFirstPaidReward: vi.fn(async () => undefined),
}));
vi.mock('./PaymentOrderTelemetry.js', () => ({
  observePaymentOrderSettled: vi.fn(),
  observePaymentOrderFailed: vi.fn(),
}));

const NOW = Date.parse('2026-11-03T08:00:00.000Z');

function order(
  id: string,
  overrides: Partial<MiniappPaymentOrderRow> = {}
): MiniappPaymentOrderRow {
  return {
    id,
    user_id: '00000000-0000-0000-0000-000000000001',
    status: 'pending',
    payment_type: 'alipay',
    amount_cents: 600,
    credits_amount: 600,
    bonus_credits: 0,
    provider_transaction_id: `tx_${id}`,
    credits_added: false,
    created_at: '2026-11-03T07:50:00.000Z',
    expires_at: '2026-11-03T08:05:00.000Z',
    paid_at: null,
    settled_by: null,
    product_type: 'credits',
    product_id: 'plan-entry',
    vip_duration_days: null,
    vip_bonus_credits: null,
    fulfillment_applied: false,
    vip_valid_until: null,
    next_reconcile_at: '2026-11-03T07:51:00.000Z',
    last_reconciled_at: null,
    reconcile_attempts: 0,
    reconcile_locked_until: null,
    ...overrides,
  };
}

function item(
  o: MiniappPaymentOrderRow,
  overrides: Partial<PaymentLookupItem> = {}
): PaymentLookupItem {
  return {
    transactionId: o.provider_transaction_id!,
    found: true,
    status: 'pending',
    amount: '6',
    currency: 'CNY',
    orderId: o.id,
    ...overrides,
  };
}

function harness(
  candidates: MiniappPaymentOrderRow[],
  lookup: (ids: string[]) => PaymentLookupResult
) {
  const byId = new Map(candidates.map((o) => [o.id, o]));
  const orders = {
    listRecentUnsettled: vi.fn(async () => candidates),
    expirePendingById: vi.fn(async () => true),
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
    complete: vi.fn(
      async (id: string, _tx: string | null, settledBy: MiniappPaymentOrderRow['settled_by']) => ({
        ...byId.get(id)!,
        status: 'completed' as const,
        credits_added: true,
        fulfillment_applied: true,
        settled_by: settledBy,
      })
    ),
    reopenExpired: vi.fn(async () => undefined),
  };
  const gateway = { lookupPayments: vi.fn(async (ids: string[]) => lookup(ids)) };
  const events = { recordOperationEvent: vi.fn(async () => undefined) };
  const log = { biz: { info: vi.fn() }, sys: { warn: vi.fn(), error: vi.fn() } };
  const run = (trigger: 'fast_reconcile' | 'expiry_reconcile' = 'fast_reconcile') =>
    runPaymentReconciliation({
      orders,
      gateway,
      log: log as never,
      paymentEnabled: true,
      trigger,
      now: NOW,
      events,
    });
  return { orders, gateway, events, log, run };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('runPaymentReconciliation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when payments are disabled', async () => {
    const { orders, gateway } = harness([order('A')], () => ({ success: true, items: [] }));
    const result = await runPaymentReconciliation({
      orders,
      gateway,
      log: { biz: { info: vi.fn() }, sys: { warn: vi.fn(), error: vi.fn() } } as never,
      paymentEnabled: false,
      trigger: 'fast_reconcile',
    });
    expect(result).toEqual({ checked: 0, settled: 0, closed: 0, lookupFailed: false });
    expect(orders.listRecentUnsettled).not.toHaveBeenCalled();
    expect(gateway.lookupPayments).not.toHaveBeenCalled();
  });

  it('looks up recent orders in one batch and settles the completed ones as cron', async () => {
    const paid = order('PAID');
    const waiting = order('WAIT');
    const { orders, gateway, events, run } = harness([paid, waiting], () => ({
      success: true,
      items: [item(paid, { status: 'completed' }), item(waiting)],
    }));

    const result = await run();
    await flush();

    expect(orders.listRecentUnsettled).toHaveBeenCalledWith({
      since: new Date(NOW - RECONCILE_WINDOW_MS).toISOString(),
      limit: 300,
    });
    expect(gateway.lookupPayments).toHaveBeenCalledOnce();
    expect(gateway.lookupPayments).toHaveBeenCalledWith(['tx_PAID', 'tx_WAIT']);
    expect(orders.complete).toHaveBeenCalledWith('PAID', 'tx_PAID', 'cron');
    expect(orders.complete).toHaveBeenCalledOnce();
    expect(result).toEqual({ checked: 2, settled: 1, closed: 0, lookupFailed: false });
    // 仍在等待付款的订单不记事件，免得每 30 秒刷一行。
    const kinds = events.recordOperationEvent.mock.calls.map(
      (call) => (call as unknown as [{ order_id: string | null }])[0].order_id
    );
    expect(kinds).not.toContain('WAIT');
  });

  it('credits a locally expired order that the customer paid late', async () => {
    const late = order('LATE', { status: 'expired' });
    const { orders, run } = harness([late], () => ({
      success: true,
      items: [item(late, { status: 'completed' })],
    }));

    expect((await run()).settled).toBe(1);
    expect(orders.reopenExpired).toHaveBeenCalledWith('LATE');
  });

  it.each(['failed', 'expired', 'cancelled'])(
    'closes a pending order the provider reports as %s',
    async (status) => {
      const dead = order('DEAD');
      const { orders, events, run } = harness([dead], () => ({
        success: true,
        items: [item(dead, { status })],
      }));

      const result = await run();
      await flush();

      expect(orders.expirePendingById).toHaveBeenCalledWith('DEAD');
      expect(orders.complete).not.toHaveBeenCalled();
      expect(result.closed).toBe(1);
      expect(events.recordOperationEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'unpaid', error_class: `provider_${status}` })
      );
    }
  );

  it('splits more than 100 candidates into several lookups', async () => {
    const many = Array.from({ length: 150 }, (_, i) => order(`O${i}`));
    const { gateway, run } = harness(many, (ids) => ({
      success: true,
      items: ids.map((id) => ({ transactionId: id, found: true, status: 'pending' })),
    }));

    await run();

    expect(gateway.lookupPayments).toHaveBeenCalledTimes(2);
    expect(gateway.lookupPayments.mock.calls[0]?.[0]).toHaveLength(100);
    expect(gateway.lookupPayments.mock.calls[1]?.[0]).toHaveLength(50);
  });

  it('reports a failed lookup so the expiry job can skip closing orders', async () => {
    const { orders, events, run } = harness([order('A')], () => ({
      success: false,
      errorClass: 'timeout',
      errorMessage: 'timeout',
    }));

    const result = await run('expiry_reconcile');
    await flush();

    expect(result.lookupFailed).toBe(true);
    expect(orders.complete).not.toHaveBeenCalled();
    expect(events.recordOperationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: 'expiry_reconcile',
        outcome: 'failed',
        error_class: 'timeout',
      })
    );
  });

  it.each([
    ['provider_not_found', { found: false }],
    ['provider_ref_mismatch', { status: 'completed', orderId: 'SOMEONE_ELSE' }],
    ['currency_mismatch', { status: 'completed', currency: 'USD' }],
  ] as const)(
    'refuses to settle on %s and records it once per order',
    async (errorClass, overrides) => {
      const odd = order('ODD');
      const { orders, events, run } = harness([odd], () => ({
        success: true,
        items: [item(odd, overrides)],
      }));

      await run();
      await flush();

      expect(orders.complete).not.toHaveBeenCalled();
      expect(events.recordOperationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_key: `fast_reconcile:${errorClass}:ODD`,
          outcome: 'failed',
          error_class: errorClass,
        })
      );
    }
  );

  it('keeps going when one order fails to settle', async () => {
    const first = order('FIRST');
    const second = order('SECOND');
    const { orders, run } = harness([first, second], () => ({
      success: true,
      items: [item(first, { status: 'completed' }), item(second, { status: 'completed' })],
    }));
    orders.findById.mockRejectedValueOnce(new Error('db hiccup'));

    const result = await run();

    expect(result.settled).toBe(1);
    expect(orders.complete).toHaveBeenCalledWith('SECOND', 'tx_SECOND', 'cron');
  });
});
