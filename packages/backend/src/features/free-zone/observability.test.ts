import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservationEvent } from '../../platform/observability/events.js';

const mocks = vi.hoisted(() => ({ records: [] as ObservationEvent[] }));
vi.mock('../../platform/observability/runtime.js', async () => {
  const { createObserver } = await import('../../platform/observability/core.js');
  return {
    observation: createObserver([
      (event) => {
        mocks.records.push(event);
      },
    ]),
  };
});
vi.mock('../../platform/runtime-config.js', () => ({ getLlmProviderRuntimeConfig: vi.fn() }));
import { fetchSurplusMarketBook } from './surplus-market.js';

beforeEach(() => {
  mocks.records.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('free-zone observation boundaries', () => {
  it('observes the order book request without changing its deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ offers: [] }));
    vi.stubGlobal('fetch', fetchImpl);
    const book = await fetchSurplusMarketBook('test/model', { origin: 'https://market.invalid' });
    expect(book.offers).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const terminals = mocks.records.filter((event) => event.event === 'operation.terminal');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ operation: 'free_zone.market', upstream_status: 200 });
    expect(JSON.stringify(mocks.records)).not.toContain('market.invalid');
  });

  it('preserves market timeout failures and never adds retries', async () => {
    const timeout = new DOMException('private-timeout', 'TimeoutError');
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', fetchImpl);
    await expect(
      fetchSurplusMarketBook('test/model', { origin: 'https://market.invalid' })
    ).rejects.toMatchObject({ cause: timeout });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const terminals = mocks.records.filter((event) => event.event === 'operation.terminal');
    expect(terminals.every((event) => event.outcome === 'timed_out')).toBe(true);
    expect(JSON.stringify(mocks.records)).not.toContain('private-timeout');
  });
});
