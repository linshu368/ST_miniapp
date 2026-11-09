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
  it('selects only due new-provider orders, including missing references, in persistent queue order', async () => {
    results.push({ data: [], error: null });
    const signal = AbortSignal.timeout(1000);
    await new MiniappPaymentOrderRepository().listRecentUnsettled({
      since: 'since',
      now: 'now',
      limit: 30,
      signal,
    });
    expect(chain.like).toHaveBeenCalledWith('id', 'EP%');
    expect(chain.lte).toHaveBeenCalledWith('next_reconcile_at', 'now');
    expect(chain.order).toHaveBeenNthCalledWith(1, 'next_reconcile_at', { ascending: true });
    expect(chain.abortSignal).toHaveBeenCalledWith(signal);
    expect(chain.is).not.toHaveBeenCalled();
  });
});
