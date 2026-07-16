import { describe, expect, it, vi } from 'vitest';
import { OpenRouterModelsClient } from './openrouter-models.js';

const responseBody = {
  data: [
    {
      id: 'google/gemini-flash',
      canonical_slug: 'google/gemini-flash',
      name: 'Gemini Flash',
      description: 'Fast model',
      context_length: 1_000_000,
      pricing: {
        prompt: '0.0000004',
        completion: '0.0000012',
      },
      expiration_date: null,
    },
  ],
};

describe('OpenRouterModelsClient', () => {
  it('normalizes and caches the upstream model directory', async () => {
    const fetchImpl = vi.fn(async () => Response.json(responseBody));
    let now = Date.parse('2026-07-17T00:00:00.000Z');
    const client = new OpenRouterModelsClient({
      fetchImpl,
      now: () => now,
      cacheTtlMs: 1_000,
    });

    const first = await client.getModels();
    now += 500;
    const second = await client.getModels();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.models[0]).toMatchObject({
      id: 'google/gemini-flash',
      prompt_usd_per_token: 0.0000004,
      completion_usd_per_token: 0.0000012,
    });
  });

  it('returns stale cached data when an upstream refresh fails', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(responseBody))
      .mockRejectedValueOnce(new Error('network unavailable'));
    let now = Date.parse('2026-07-17T00:00:00.000Z');
    const client = new OpenRouterModelsClient({
      fetchImpl,
      now: () => now,
      cacheTtlMs: 100,
    });

    await client.getModels();
    now += 101;
    const stale = await client.getModels();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stale.stale).toBe(true);
    expect(stale.models).toHaveLength(1);
  });

  it('rejects an invalid upstream response when no cache exists', async () => {
    const client = new OpenRouterModelsClient({
      fetchImpl: vi.fn(async () => Response.json({ data: [{ id: 'broken' }] })),
    });

    await expect(client.getModels()).rejects.toThrow();
  });
});
