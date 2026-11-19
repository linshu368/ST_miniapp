import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MiniappPaymentOrderRow } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type {
  PaymentQueryResult,
  PaymentQueryTarget,
} from '../../../infrastructure/payment/PaymentGateway.js';
import {
  type PaymentReconciliationResult,
  RECONCILE_BASE_DELAY_SECONDS,
  RECONCILE_MAX_DELAY_SECONDS,
  RECONCILE_WINDOW_MS,
  runPaymentReconciliation,
  runPaymentReconciliationLoop,
} from './PaymentReconciliation.js';
import {
  currentContext,
  newContext,
  withContext,
} from '../../../platform/observability/context.js';
import { createObserver } from '../../../platform/observability/core.js';
import { observation } from '../../../platform/observability/runtime.js';
import { safeLogRecord } from '../../../platform/observability/safe-log.js';
import type { ObservationEvent } from '../../../platform/observability/events.js';

vi.mock('../../../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/invite-rewards.js', () => ({
  checkInviteFirstPaidReward: vi.fn(async () => undefined),
}));
const emptyResult = (): PaymentReconciliationResult => ({
  checked: 0,
  settled: 0,
  closed: 0,
  lookupFailed: false,
  unpaidCount: 0,
  failedCount: 0,
  stoppedCount: 0,
  skippedCount: 0,
  criticalFailureCount: 0,
  failureCounts: {},
});
const NOW = Date.parse('2026-11-03T08:00:00.000Z');

describe('reconciliation round correlation', () => {
  it('keeps pass/reporters together, isolates rounds, and leaves sleep outside the round', async () => {
    const events: ObservationEvent[] = [];
    const observer = createObserver([
      (event) => {
        events.push(event);
      },
    ]);
    const spy = vi.spyOn(observation, 'start').mockImplementation(observer.start);
    const shutdown = new AbortController();
    const traces: string[] = [];
    const reported: string[] = [];
    const failure = new Error('fixture round failure');
    const outer = newContext();
    let round = 0;
    try {
      await withContext(outer, () =>
        runPaymentReconciliationLoop({
          signal: shutdown.signal,
          runPass: async () => {
            traces.push(currentContext()!.trace_id);
            if (++round === 2) throw failure;
            return { ...emptyResult(), checked: 1, lookupFailed: round === 3 };
          },
          onPass: () => {
            reported.push(currentContext()!.trace_id);
          },
          onError: (err) => {
            expect(err).toBe(failure);
            reported.push(currentContext()!.trace_id);
          },
          sleep: async () => {
            expect(currentContext()!.trace_id).toBe(outer.trace_id);
            if (round === 3) shutdown.abort();
          },
        })
      );
      expect(reported).toEqual(traces);
      expect(new Set(traces).size).toBe(3);
      expect(traces).not.toContain(outer.trace_id);
      const terminals = events.filter((event) => event.event === 'operation.terminal');
      expect(terminals.map((event) => event.outcome)).toEqual(['succeeded', 'failed', 'degraded']);
      expect(terminals.map((event) => event.trace_id)).toEqual(traces);
      expect(terminals[1]?.err).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves cancellation without error callbacks or another sleep', async () => {
    const shutdown = new AbortController();
    const onError = vi.fn();
    const sleep = vi.fn();
    await runPaymentReconciliationLoop({
      signal: shutdown.signal,
      onError,
      sleep,
      runPass: async () => {
        shutdown.abort();
        throw new Error('cancelled fixture');
      },
      onPass: vi.fn(),
    });
    expect(onError).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});

function order(
  id: string,
  overrides: Partial<MiniappPaymentOrderRow> = {}
): MiniappPaymentOrderRow {
  return {
    id: id.startsWith('MA') ? id : 'EP' + Buffer.from(id).toString('hex').padStart(30, '0'),
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
    ...overrides,
  };
}

function harness(
  candidates: MiniappPaymentOrderRow[],
  query: (order: PaymentQueryTarget, signal?: AbortSignal) => Promise<PaymentQueryResult>
) {
  const byId = new Map(candidates.map((o) => [o.id, o]));
  const orders = {
    claimDueReconciliations: vi.fn(async () => candidates),
    recordReconcileUnpaid: vi.fn(async () => ({
      confirmations: 1,
      stopped: false,
      recorded: true,
    })),
    expirePendingById: vi.fn(async () => true),
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
    attachProviderTransaction: vi.fn(async () => true),
    complete: vi.fn(
      async (id: string, _ref: string | null, settledBy: MiniappPaymentOrderRow['settled_by']) => ({
        ...byId.get(id)!,
        status: 'completed' as const,
        credits_added: true,
        fulfillment_applied: true,
        settled_by: settledBy,
      })
    ),
    reopenExpired: vi.fn(async () => undefined),
  };
  const gateway = { queryOrder: vi.fn(query) };
  const events = { recordOperationEvent: vi.fn(async (_event: unknown) => undefined) };
  const sink = () => vi.fn((_fields: Record<string, unknown>, _message: string) => undefined);
  const log = { biz: { info: sink() }, sys: { info: sink(), warn: sink(), error: sink() } };
  const run = (signal?: AbortSignal, paymentEnabled = true) =>
    runPaymentReconciliation({
      orders,
      gateway,
      log: log as never,
      events,
      signal,
      paymentEnabled,
      trigger: 'fast_reconcile',
      now: NOW,
    });
  return { orders, gateway, events, log, run };
}
const unpaid = async (): Promise<PaymentQueryResult> => ({
  success: true,
  paid: false,
  status: 'pending',
});
const paid = async (o: PaymentQueryTarget): Promise<PaymentQueryResult> => ({
  success: true,
  paid: true,
  amount: '6.000',
  tradeNo: o.provider_transaction_id ?? 'recovered',
});

describe('epay bounded reconciliation', () => {
  beforeEach(() => vi.clearAllMocks());
  it('does nothing when credentials are unavailable or the queue is empty', async () => {
    const h = harness([], unpaid);
    await h.run(undefined, false);
    expect(h.orders.claimDueReconciliations).not.toHaveBeenCalled();
    await h.run();
    expect(h.gateway.queryOrder).not.toHaveBeenCalled();
  });
  it('settles paid orders claimed with exponential backoff before any query', async () => {
    const o = order('paid');
    const h = harness([o], paid);
    expect(await h.run()).toMatchObject({ checked: 1, settled: 1, closed: 0, lookupFailed: false });
    expect(h.orders.claimDueReconciliations).toHaveBeenCalledExactlyOnceWith({
      now: new Date(NOW).toISOString(),
      windowStart: new Date(NOW - RECONCILE_WINDOW_MS).toISOString(),
      limit: 30,
      baseDelaySeconds: RECONCILE_BASE_DELAY_SECONDS,
      maxDelaySeconds: RECONCILE_MAX_DELAY_SECONDS,
      signal: expect.any(AbortSignal),
    });
    expect([RECONCILE_BASE_DELAY_SECONDS, RECONCILE_MAX_DELAY_SECONDS]).toEqual([30, 7200]);
    expect(h.orders.claimDueReconciliations.mock.invocationCallOrder[0]).toBeLessThan(
      h.gateway.queryOrder.mock.invocationCallOrder[0]!
    );
    expect(h.orders.complete).toHaveBeenCalledWith(o.id, o.provider_transaction_id, 'cron');
  });
  it('recovers expired orders and missing creation references but excludes legacy orders', async () => {
    const late = order('late', { status: 'expired', provider_transaction_id: null });
    const h = harness([late, order('MA_legacy')], paid);
    expect((await h.run()).settled).toBe(1);
    expect(h.gateway.queryOrder).toHaveBeenCalledOnce();
    expect(h.orders.attachProviderTransaction).toHaveBeenCalledWith(late.id, 'recovered');
    expect(h.orders.reopenExpired).toHaveBeenCalledWith(late.id);
  });
  it('expires only confirmed unpaid orders beyond the local deadline', async () => {
    const expired = order('old', { expires_at: new Date(NOW - 1).toISOString() });
    const h = harness([expired, order('new')], unpaid);
    expect((await h.run()).closed).toBe(1);
    expect(h.orders.expirePendingById).toHaveBeenCalledExactlyOnceWith(expired.id);
    expect(h.orders.recordReconcileUnpaid).toHaveBeenCalledExactlyOnceWith({
      orderId: expired.id,
      claimedAt: new Date(NOW).toISOString(),
      signal: expect.any(AbortSignal),
    });
  });
  it('preserves unknown query outcomes and still settles other orders', async () => {
    const first = order('failure', { expires_at: new Date(NOW - 1).toISOString() });
    const second = order('ok');
    const h = harness([first, second], async (o) =>
      o.id === first.id ? { success: false, errorClass: 'timeout' } : paid(o)
    );
    expect(await h.run()).toMatchObject({
      checked: 2,
      settled: 1,
      closed: 0,
      lookupFailed: true,
      failedCount: 1,
      criticalFailureCount: 0,
    });
    expect(h.orders.expirePendingById).not.toHaveBeenCalled();
    expect(h.orders.recordReconcileUnpaid).not.toHaveBeenCalled();
    expect(h.log.sys.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.reconciliation.summary',
        failedCount: 1,
        timeoutCount: 1,
      }),
      expect.any(String)
    );
    expect(
      safeLogRecord(h.log.sys.warn.mock.calls[0]![0] as Record<string, unknown>)
    ).toMatchObject({ failedCount: 1, checkedCount: 2, timeoutCount: 1, outcome: 'degraded' });
  });
  it('never grants mismatched amounts and continues after a database error', async () => {
    const h = harness([order('a'), order('b'), order('c')], paid);
    h.orders.findById.mockRejectedValueOnce(new Error('db temporarily down'));
    h.gateway.queryOrder.mockResolvedValueOnce({
      success: true,
      paid: true,
      amount: '6.01',
      tradeNo: 'wrong',
    });
    const result = await h.run();
    expect(result.lookupFailed).toBe(true);
    expect(result.settled).toBeGreaterThan(0);
    expect(h.orders.complete.mock.calls.length).toBeLessThan(3);
  });
  it('caps each pass at 30 and query concurrency at three', async () => {
    let active = 0,
      peak = 0;
    const h = harness(
      Array.from({ length: 45 }, (_, i) => order(String(i))),
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return unpaid();
      }
    );
    expect((await h.run()).checked).toBe(30);
    expect(peak).toBe(3);
  });
  it('stops dispatch on cancellation and waits for in-flight queries to abort', async () => {
    const controller = new AbortController();
    const h = harness(
      Array.from({ length: 10 }, (_, i) => order(String(i))),
      async (_o, signal) => {
        setImmediate(() => controller.abort());
        await new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true })
        );
        return { success: false, errorClass: 'timeout' };
      }
    );
    const result = await h.run(controller.signal);
    expect(result.lookupFailed).toBe(true);
    expect(h.gateway.queryOrder).toHaveBeenCalledTimes(3);
    expect(h.orders.expirePendingById).not.toHaveBeenCalled();
    expect(h.orders.complete).not.toHaveBeenCalled();
  });
});

describe('automatic reconciliation stop boundaries', () => {
  it('excludes older than eight hours at dispatch but includes the exact boundary', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const h = harness(
        [
          order('old', { created_at: new Date(NOW - RECONCILE_WINDOW_MS - 1).toISOString() }),
          order('boundary', { created_at: new Date(NOW - RECONCILE_WINDOW_MS).toISOString() }),
        ],
        unpaid
      );
      expect(await h.run()).toMatchObject({ checked: 1, skippedCount: 1 });
      expect(h.gateway.queryOrder).toHaveBeenCalledOnce();
      expect(RECONCILE_WINDOW_MS).toBe(8 * 60 * 60 * 1000);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('rechecks queued orders while allowing an in-flight paid response to settle', async () => {
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => NOW + elapsed);
    try {
      const candidates = Array.from({ length: 5 }, (_, i) =>
        order(String(i), { created_at: new Date(NOW - RECONCILE_WINDOW_MS + 10).toISOString() })
      );
      const h = harness(candidates, async (o) => {
        await Promise.resolve();
        elapsed = 20;
        return paid(o);
      });
      expect(await h.run()).toMatchObject({ checked: 3, settled: 3, skippedCount: 2 });
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('counts only confirmed post-expiry unpaid results and reports the third once', async () => {
    const spy = vi.spyOn(observation, 'emit');
    try {
      const h = harness(
        [
          order('expired', { status: 'expired', expires_at: new Date(NOW - 1).toISOString() }),
          order('not-expired'),
        ],
        unpaid
      );
      h.orders.recordReconcileUnpaid.mockResolvedValueOnce({
        confirmations: 3,
        stopped: true,
        recorded: true,
      });
      expect(await h.run()).toMatchObject({ unpaidCount: 2, stoppedCount: 1 });
      expect(h.orders.recordReconcileUnpaid).toHaveBeenCalledOnce();
      expect(
        spy.mock.calls.filter(([name]) => name === 'payment.reconcile.unpaid_limit_reached')
      ).toHaveLength(1);
      h.orders.recordReconcileUnpaid.mockResolvedValue({
        confirmations: 3,
        stopped: true,
        recorded: false,
      });
      expect(await h.run()).toMatchObject({ stoppedCount: 0 });
      expect(
        spy.mock.calls.filter(([name]) => name === 'payment.reconcile.unpaid_limit_reached')
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('keeps configuration failures and counter persistence failures at error level', async () => {
    const h = harness(
      [order('config'), order('db', { expires_at: new Date(NOW - 1).toISOString() })],
      unpaid
    );
    h.gateway.queryOrder.mockResolvedValueOnce({ success: false, errorClass: 'configuration' });
    h.orders.recordReconcileUnpaid.mockRejectedValueOnce(new Error('counter unavailable'));
    expect(await h.run()).toMatchObject({
      failedCount: 2,
      criticalFailureCount: 2,
      stoppedCount: 0,
    });
    expect(h.log.sys.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment.reconciliation.summary', failedCount: 2 }),
      expect.any(String)
    );
  });
});

describe('unknown response is not a confirmed unpaid result', () => {
  it('keeps unknown successful payloads failed and does not increment the stop counter', async () => {
    const h = harness(
      [order('unknown', { expires_at: new Date(NOW - 1).toISOString() })],
      async () => ({ success: true })
    );
    expect(await h.run()).toMatchObject({
      failedCount: 1,
      criticalFailureCount: 1,
      unpaidCount: 0,
    });
    expect(h.orders.recordReconcileUnpaid).not.toHaveBeenCalled();
    expect(h.events.recordOperationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', error_class: 'response_invalid' })
    );
  });
});

describe('shutdown does not mask an independent fault', () => {
  it('keeps an unexpected database or gateway exception visible even if cancellation arrives', async () => {
    const controller = new AbortController();
    const h = harness([order('shutdown-fault')], async () => {
      controller.abort();
      throw new Error('independent failure');
    });
    expect(await h.run(controller.signal)).toMatchObject({
      criticalFailureCount: 1,
      failedCount: 1,
    });
    expect(h.log.sys.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment.reconcile.order_failed', err: expect.any(Error) }),
      expect.any(String)
    );
  });
});
