import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  LlmProviderRoutingConfigSchema,
  resolveProviderPreferences,
} from '../api/provider-routing.js';

const validConfig = {
  rules: [
    {
      openrouter_model_id: 'deepseek/deepseek-chat-v3.2',
      blocked_providers: ['alibaba'],
      preferred_providers: [],
      note: 'Alibaba 失败率 52.78%',
    },
    {
      openrouter_model_id: 'google/gemini-3.5-flash-lite',
      blocked_providers: [],
      preferred_providers: ['google-vertex'],
      note: 'Google 优先，AI Studio 兜底',
    },
  ],
};

describe('LlmProviderRoutingConfigSchema', () => {
  it('accepts per-model block and prefer rules', () => {
    const parsed = LlmProviderRoutingConfigSchema.parse(validConfig);
    expect(parsed.rules).toHaveLength(2);
  });

  it('accepts the empty default config', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse(DEFAULT_LLM_PROVIDER_ROUTING_CONFIG).success
    ).toBe(true);
  });

  it('fills omitted arrays and note with defaults', () => {
    const parsed = LlmProviderRoutingConfigSchema.parse({
      rules: [{ openrouter_model_id: 'a/b', blocked_providers: ['alibaba'] }],
    });
    expect(parsed.rules[0]).toEqual({
      openrouter_model_id: 'a/b',
      blocked_providers: ['alibaba'],
      preferred_providers: [],
      note: '',
    });
  });

  it('rejects a rule that neither blocks nor prefers any provider', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [
          { openrouter_model_id: 'a/b', blocked_providers: [], preferred_providers: [], note: '' },
        ],
      }).success
    ).toBe(false);
  });

  it('rejects duplicate rules for the same model', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [
          { openrouter_model_id: 'a/b', blocked_providers: ['x'] },
          { openrouter_model_id: 'a/b', blocked_providers: ['y'] },
        ],
      }).success
    ).toBe(false);
  });

  it('rejects a provider that is both blocked and preferred', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [
          {
            openrouter_model_id: 'a/b',
            blocked_providers: ['alibaba'],
            preferred_providers: ['Alibaba'],
          },
        ],
      }).success
    ).toBe(false);
  });

  it('rejects duplicate providers inside one list', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [{ openrouter_model_id: 'a/b', blocked_providers: ['alibaba', 'ALIBABA'] }],
      }).success
    ).toBe(false);
  });

  it('rejects model ids without a vendor prefix', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [{ openrouter_model_id: 'not-a-slug', blocked_providers: ['alibaba'] }],
      }).success
    ).toBe(false);
  });
});

describe('resolveProviderPreferences', () => {
  const config = LlmProviderRoutingConfigSchema.parse(validConfig);

  it('maps blocked providers to provider.ignore', () => {
    expect(resolveProviderPreferences(config, 'deepseek/deepseek-chat-v3.2')).toEqual({
      ignore: ['alibaba'],
    });
  });

  it('maps preferred providers to provider.order with fallbacks enabled', () => {
    expect(resolveProviderPreferences(config, 'google/gemini-3.5-flash-lite')).toEqual({
      order: ['google-vertex'],
      allow_fallbacks: true,
    });
  });

  it('matches the model id case-insensitively', () => {
    expect(resolveProviderPreferences(config, 'DeepSeek/DeepSeek-Chat-V3.2')).toEqual({
      ignore: ['alibaba'],
    });
  });

  it('returns null when no rule targets the model', () => {
    expect(resolveProviderPreferences(config, 'anthropic/claude-sonnet-4.5')).toBeNull();
    expect(
      resolveProviderPreferences(DEFAULT_LLM_PROVIDER_ROUTING_CONFIG, 'deepseek/deepseek-chat-v3.2')
    ).toBeNull();
  });
});
