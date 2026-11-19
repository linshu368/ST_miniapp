import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniappPaymentOrderRepository } from './MiniappPaymentOrderRepository.js';

const { chain, results } = vi.hoisted(() => {
  const results: Array<{ data: unknown; error: unknown }> = [];
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of [
    'from',
    'update',
    'eq',
    'in',
    'is',
    'select',
    'like',
    'gte',
    'lte',
    'order',
    'limit',
    'rpc',
    'abortSignal',
  ])
    chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => results.shift());
  chain.then = vi.fn((resolve: (value: unknown) => unknown) => resolve(results.shift()));
  return { chain, results };
});
vi.mock('../../lib/supabase.js', () => ({ getDomainDb: () => chain }));
beforeEach(() => {
  vi.clearAllMocks();
  results.length = 0;
});

describe('payment order compare-and-set persistence', () => {
  it('binds only a previously empty reference in a recoverable state', async () => {
    results.push({ data: { id: 'order' }, error: null });
    expect(
      await new MiniappPaymentOrderRepository().attachProviderTransaction('order', 'transaction')
    ).toBe(true);
    expect(chain.update).toHaveBeenCalledWith({ provider_transaction_id: 'transaction' });
    expect(chain.is).toHaveBeenCalledWith('provider_transaction_id', null);
    expect(chain.in).toHaveBeenCalledWith('status', ['pending', 'expired']);
  });
  it.each([
    ['transaction', true],
    ['other-transaction', false],
  ])('checks the reference after a racing write (%s)', async (reference, accepted) => {
    results.push(
      { data: null, error: null },
      { data: { status: 'completed', provider_transaction_id: reference }, error: null }
    );
    expect(
      await new MiniappPaymentOrderRepository().attachProviderTransaction('order', 'transaction')
    ).toBe(accepted);
    expect(chain.update).toHaveBeenCalledOnce();
  });
  it('does not overwrite an early callback with a failed create response', async () => {
    results.push({ data: null, error: null });
    await new MiniappPaymentOrderRepository().markFailed('order');
    expect(chain.eq).toHaveBeenCalledWith('status', 'pending');
    expect(chain.is).toHaveBeenCalledWith('provider_transaction_id', null);
  });
  it('claims due reconcile jobs through the backoff RPC and returns the order rows', async () => {
    results.push({ data: [{ id: 'EP1' }], error: null });
    const signal = AbortSignal.timeout(1000);
    const rows = await new MiniappPaymentOrderRepository().claimDueReconciliations({
      now: 'now',
      windowStart: 'since',
      limit: 30,
      baseDelaySeconds: 30,
      maxDelaySeconds: 7200,
      signal,
    });
    expect(rows).toEqual([{ id: 'EP1' }]);
    expect(chain.rpc).toHaveBeenCalledWith('claim_payment_reconcile_jobs', {
      p_now: 'now',
      p_window_start: 'since',
      p_limit: 30,
      p_base_delay_seconds: 30,
      p_max_delay_seconds: 7200,
    });
    expect(chain.abortSignal).toHaveBeenCalledWith(signal);
  });
  it('records payment events through the billing RPC with deduplication left to event_key', async () => {
    results.push({ data: true, error: null });
    await new MiniappPaymentOrderRepository().recordOperationEvent({
      event_key: 'fast_reconcile:EP1:1',
      order_id: 'EP1',
      user_id: null,
      event_kind: 'fast_reconcile',
      stage: 'query',
      outcome: 'unpaid',
      source: 'gateway',
      trigger: 'fast_reconcile',
      duration_ms: 812,
      occurred_at: '2026-11-18T15:00:00.000Z',
    });
    expect(chain.rpc).toHaveBeenCalledWith('record_payment_event', {
      p_event_key: 'fast_reconcile:EP1:1',
      p_order_id: 'EP1',
      p_user_id: null,
      p_event_kind: 'fast_reconcile',
      p_stage: 'query',
      p_outcome: 'unpaid',
      p_source: 'gateway',
      p_trigger: 'fast_reconcile',
      p_error_class: null,
      p_duration_ms: 812,
      p_occurred_at: '2026-11-18T15:00:00.000Z',
      p_metadata: {},
    });
    results.push({ data: null, error: { message: 'check violation' } });
    await expect(
      new MiniappPaymentOrderRepository().recordOperationEvent({
        event_key: 'x',
        order_id: null,
        user_id: null,
        event_kind: 'webhook',
        stage: 'callback',
        outcome: 'failed',
        source: 'gateway',
        trigger: 'webhook',
        occurred_at: '2026-11-18T15:00:00.000Z',
      })
    ).rejects.toThrow('记录支付操作事件失败');
  });
  it('surfaces claim failures instead of skipping reconciliation silently', async () => {
    results.push({ data: null, error: { message: 'boom' } });
    await expect(
      new MiniappPaymentOrderRepository().claimDueReconciliations({
        now: 'now',
        windowStart: 'since',
        limit: 30,
        baseDelaySeconds: 30,
        maxDelaySeconds: 7200,
      })
    ).rejects.toThrow('领取待对账支付订单失败');
  });
});

describe('persistent unpaid confirmation result', () => {
  const input = { orderId: 'EP1', claimedAt: '2026-11-19T00:00:00Z' };
  it('sends the claim identity, composes cancellation with a timeout and returns the checkpoint', async () => {
    const controller = new AbortController();
    results.push({ data: [{ confirmations: 3, stopped: true, recorded: true }], error: null });
    expect(
      await new MiniappPaymentOrderRepository().recordReconcileUnpaid({
        ...input,
        signal: controller.signal,
      })
    ).toEqual({ confirmations: 3, stopped: true, recorded: true });
    expect(chain.rpc).toHaveBeenCalledWith('record_payment_reconcile_unpaid', {
      p_order_id: input.orderId,
      p_claimed_at: input.claimedAt,
    });
    const signal = chain.abortSignal!.mock.calls[0]![0] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
  it.each([
    null,
    [],
    [{ confirmations: 4, stopped: true, recorded: true }],
    [{ confirmations: 1, stopped: 'false', recorded: true }],
  ])('rejects malformed results (%j)', async (data) => {
    results.push({ data, error: null });
    await expect(
      new MiniappPaymentOrderRepository().recordReconcileUnpaid(input)
    ).rejects.toThrow();
  });
  it('preserves a database failure as the error cause', async () => {
    const error = { code: '42501' };
    results.push({ data: null, error });
    await expect(
      new MiniappPaymentOrderRepository().recordReconcileUnpaid(input)
    ).rejects.toMatchObject({ cause: error });
  });
});
