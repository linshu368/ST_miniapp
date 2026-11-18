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
