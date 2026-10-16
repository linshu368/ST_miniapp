import { describe, expect, it } from 'vitest';
import { buildGenerationMetadata, isCompleteGenerationData } from './openrouter-metadata.js';

describe('buildGenerationMetadata', () => {
  it('keeps OpenRouter diagnostics but excludes prompt, reply and credential-shaped fields', () => {
    const metadata = buildGenerationMetadata({
      id: 'gen-1',
      finish_reason: 'stop',
      usage: 0.001,
      provider_name: 'CoreWeave',
      prompt: 'private prompt',
      choices: [{ message: { content: 'private reply' } }],
      nested: { input: 'private input', model: 'routed/model' },
      api_key: 'secret',
    });

    expect(metadata.llm_generation_data).toEqual({
      id: 'gen-1',
      finish_reason: 'stop',
      usage: 0.001,
      provider_name: 'CoreWeave',
      nested: { model: 'routed/model' },
    });
    expect(metadata.provider_name).toBe('CoreWeave');
    expect(Object.keys(metadata).filter((key) => key.startsWith('llm_'))).toEqual([
      'llm_generation_data',
    ]);
  });

  it('preserves original fields and zero usage_cache without adding cache_discount', () => {
    const response = {
      provider_name: 'Google',
      finish_reason: 'stop',
      usage: 0,
      usage_cache: 0,
      native_tokens_cached: 0,
      native_tokens_reasoning: 0,
      native_tokens_completion: 20,
      native_tokens_prompt: 100,
      latency: 0,
      generation_time: 200,
      model: 'vendor/model',
    };
    expect(buildGenerationMetadata(response)).toEqual({
      ...response,
      llm_generation_data: response,
    });
    expect(buildGenerationMetadata(response)).not.toHaveProperty('cache_discount');
  });

  it('keeps missing usage_cache null and rejects invalid numeric metadata', () => {
    const metadata = buildGenerationMetadata({
      usage: '0.01',
      latency: -1,
      generation_time: Infinity,
      native_tokens_prompt: 1.5,
      native_tokens_completion: -1,
    });
    expect(metadata).toMatchObject({
      usage: null,
      usage_cache: null,
      latency: null,
      generation_time: null,
      native_tokens_prompt: null,
      native_tokens_completion: null,
    });
  });
});

describe('isCompleteGenerationData', () => {
  it('does not require optional usage_cache and accepts zero measurements', () => {
    expect(
      isCompleteGenerationData({ usage: 0, latency: 0, generation_time: 0, finish_reason: 'stop' })
    ).toBe(true);
  });

  it.each([
    null,
    { error: { code: 404 } },
    { usage: null, latency: 0, generation_time: 0, finish_reason: 'stop' },
    { usage: 0, latency: 0, generation_time: 0, finish_reason: null },
  ])('keeps absent/error statistics incomplete', (data) => {
    expect(isCompleteGenerationData(data)).toBe(false);
  });
});
