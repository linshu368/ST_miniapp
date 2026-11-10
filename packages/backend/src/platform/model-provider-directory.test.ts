import { describe, expect, it, vi } from 'vitest';
import { SurplusProviderDirectoryClient } from './model-provider-directory.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const validResponse = {
  data: [
    {
      id: 'anthropic/claude-haiku-5.5',
      name: 'Claude Haiku 5.5',
      description: 'Fast model',
      context_length: 200_000,
      pricing: { prompt: '0.000001', completion: '0.000005' },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['temperature', 'reasoning_effort'],
    },
    {
      id: 'image/example-model',
      pricing: { prompt: 0.0000002, completion: 0.0000002 },
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
    },
  ],
};

describe('SurplusProviderDirectoryClient', () => {
  it('maps the public Surplus Intelligence text-model list without sending the generation key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(validResponse));
    const client = new SurplusProviderDirectoryClient({
      endpoint: 'https://surplus.example/v1/models',
      fetchImpl,
      now: () => Date.parse('2026-11-06T00:00:00.000Z'),
    });

    const directory = await client.getModels();
    expect(client.peekModels()).toEqual(directory);

    expect(directory).toMatchObject({
      provider: 'surplus',
      fetched_at: '2026-11-06T00:00:00.000Z',
      stale: false,
      models: [
        {
          provider: 'surplus',
          id: 'anthropic/claude-haiku-5.5',
          context_length: 200_000,
          prompt_usd_per_token: 0.000001,
          completion_usd_per_token: 0.000005,
          status: 'available',
          supported_parameters: ['temperature', 'reasoning_effort'],
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://surplus.example/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('coalesces refreshes and serves the last cache as stale after a later failure', async () => {
    let now = 1_000;
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first)
      .mockRejectedValueOnce(new Error('network down'));
    const client = new SurplusProviderDirectoryClient({
      endpoint: 'https://surplus.example/v1/models',
      fetchImpl,
      cacheTtlMs: 100,
      now: () => now,
    });

    const pending = [client.getModels(), client.getModels()];
    expect(client.peekModels()).toBeNull();
    resolveFirst(jsonResponse(validResponse));
    const [left, right] = await Promise.all(pending);
    expect(left).toEqual(right);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 101;
    expect(client.peekModels()).toBeNull();
    await expect(client.getModels()).resolves.toMatchObject({ provider: 'surplus', stale: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed or empty usable model lists', async () => {
    const malformed = new SurplusProviderDirectoryClient({
      endpoint: 'https://surplus.example/v1/models',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ models: [] })),
    });
    await expect(malformed.getModels()).rejects.toThrow(
      'Surplus models response is not a data array'
    );

    const noPrices = new SurplusProviderDirectoryClient({
      endpoint: 'https://surplus.example/v1/models',
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ data: [{ id: 'vendor/model' }] })),
    });
    await expect(noPrices.getModels()).rejects.toThrow(
      'Surplus Intelligence returned no valid text models'
    );
  });

  it('does not trust malformed capability names or unbounded capability lists', async () => {
    for (const supported_parameters of [
      ['reasoning', 4],
      ['PRIVATE KEY'],
      Array(129).fill('reasoning'),
    ]) {
      const model = { ...validResponse.data[0], supported_parameters };
      const client = new SurplusProviderDirectoryClient({
        endpoint: 'https://surplus.example/v1/models',
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [model] })),
      });
      expect((await client.getModels()).models[0]?.supported_parameters).toBeUndefined();
    }
  });
});
