import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/model-provider-directory.js', () => ({
  getProviderModelDirectory: async () => ({
    provider: 'venice',
    fetched_at: '2026-09-29T00:00:00.000Z',
    stale: false,
    models: [
      {
        provider: 'venice',
        id: 'venice-model',
        name: 'Venice Model',
        description: null,
        context_length: 100_000,
        prompt_usd_per_token: 0.000001,
        completion_usd_per_token: 0.000002,
        status: 'available',
        raw_status_label: null,
      },
    ],
  }),
}));

const { buildVeniceMetadata } = await import('./venice-metadata.js');

describe('buildVeniceMetadata', () => {
  it('maps token details and calculates provider cost without persisting response choices', async () => {
    const metadata = await buildVeniceMetadata({
      chatHistoryId: 'history-1',
      model: 'venice-model',
      generationId: 'gen-1',
      finishReason: 'stop',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
      responseMetadata: { id: 'gen-1', model: 'venice-model' },
      latencyMs: 123,
      generationTimeMs: 456,
    });

    expect(metadata).toMatchObject({
      chat_history_id: 'history-1',
      llm_provider_name: 'venice',
      llm_native_tokens_prompt: 100,
      llm_native_tokens_completion: 20,
      llm_native_tokens_cached: 40,
      llm_native_tokens_reasoning: 5,
      llm_latency: 123,
      llm_generation_time: 456,
      llm_usage: 0.00014,
      llm_usage_cache: 0.00004,
      llm_generation_data: {
        usage: expect.objectContaining({ prompt_tokens: 100, completion_tokens: 20 }),
        pricing: {
          prompt_usd_per_token: 0.000001,
          completion_usd_per_token: 0.000002,
          prompt_cost_usd: 0.0001,
          completion_cost_usd: 0.00004,
          cached_cost_usd: 0.00004,
          total_cost_usd: 0.00014,
        },
      },
    });
    expect(metadata.llm_generation_data).not.toHaveProperty('choices');
  });
});
