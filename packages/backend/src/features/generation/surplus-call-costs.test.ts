import { describe, expect, it, vi } from 'vitest';
import { fetchSurplusRequestCostUsd } from './surplus-call-costs.js';

const options = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  baseUrl: 'https://surplus.example/v1/',
  apiKey: 'fixture-only',
});

describe('fetchSurplusRequestCostUsd', () => {
  it('reads the buyer cost of the request record as dollars', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ data: { id: 'request-1', usage: { buyer_cost_micro: '3271' } } })
    );
    await expect(
      fetchSurplusRequestCostUsd('request-1', options(fetchImpl as unknown as typeof fetch))
    ).resolves.toBe('0.003271');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://surplus.example/v1/requests/request-1',
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
  });

  it.each([
    ['a 404', async () => new Response(null, { status: 404 })],
    ['another request’s record', async () => Response.json({ data: { id: 'request-2' } })],
    ['a record without cost', async () => Response.json({ data: { id: 'request-1', usage: {} } })],
    [
      'a network failure',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('returns null for %s', async (_label, impl) => {
    await expect(
      fetchSurplusRequestCostUsd('request-1', options(vi.fn(impl) as unknown as typeof fetch))
    ).resolves.toBeNull();
  });

  it('never sends a malformed request id', async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchSurplusRequestCostUsd('../admin', options(fetchImpl as unknown as typeof fetch))
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
