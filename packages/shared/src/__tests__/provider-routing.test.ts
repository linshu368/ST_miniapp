import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  LlmProviderRoutingConfigSchema,
  resolveProviderPreferences,
  resolveSurplusRoutingRule,
  fallbackProviderPreferences,
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
  it('uses the fallback pair and latency priority while preserving model block rules', () => {
    expect(
      fallbackProviderPreferences({ order: ['slow'], ignore: ['blocked'] }, ['fast-a', 'fast-b'])
    ).toEqual({
      order: ['fast-a', 'fast-b'],
      ignore: ['blocked'],
      allow_fallbacks: true,
      sort: 'latency',
    });
    expect(fallbackProviderPreferences({ ignore: ['FAST-A'] }, ['fast-a', 'fast-b']).order).toEqual(
      ['fast-b']
    );
    expect(fallbackProviderPreferences(null, undefined)).toEqual({
      allow_fallbacks: true,
      sort: 'latency',
    });
  });
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

describe('Surplus 路由规则', () => {
  const surplusRule = {
    surplus_model_id: 'deepseek-v4.1-flash-1017',
    allowed_providers: [],
    preferred_providers: ['mistral', 'deepseek'],
    blocked_providers: [],
    min_discount_pct: 70,
    route_objective: null,
    price_tolerance_pct: null,
    note: '',
  };

  it('旧配置没有 surplus_rules 时默认为空', () => {
    expect(LlmProviderRoutingConfigSchema.parse(validConfig).surplus_rules).toEqual([]);
  });

  it('补齐省略的字段并按模型名（不分大小写）命中', () => {
    const parsed = LlmProviderRoutingConfigSchema.parse({
      rules: [],
      surplus_rules: [{ surplus_model_id: 'deepseek-v4.1-flash-1017', min_discount_pct: 70 }],
    });
    expect(parsed.surplus_rules[0]).toEqual({
      ...surplusRule,
      preferred_providers: [],
    });
    expect(resolveSurplusRoutingRule(parsed, 'DeepSeek-V4.1-Flash-1017')?.min_discount_pct).toBe(
      70
    );
    expect(resolveSurplusRoutingRule(parsed, 'gemini-3-flash-preview')).toBeNull();
  });

  it.each([
    ['什么都没设', { allowed_providers: [], preferred_providers: [], min_discount_pct: null }],
    ['同一列表重复', { preferred_providers: ['mistral', 'Mistral'] }],
    ['屏蔽又优先', { blocked_providers: ['mistral'] }],
    [
      '屏蔽又只走',
      { allowed_providers: ['deepseek'], preferred_providers: [], blocked_providers: ['deepseek'] },
    ],
    ['优先不在只走名单里', { allowed_providers: ['deepseek'] }],
    ['模型名带斜杠', { surplus_model_id: 'deepseek/deepseek-v4' }],
    ['折扣底线越界', { min_discount_pct: 101 }],
    ['不支持的派单方式', { route_objective: 'price' }],
  ])('拒绝：%s', (_label, patch) => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [],
        surplus_rules: [{ ...surplusRule, ...patch }],
      }).success
    ).toBe(false);
  });

  it('同一模型不能有两条规则', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [],
        surplus_rules: [
          surplusRule,
          { ...surplusRule, surplus_model_id: 'DEEPSEEK-V4.1-FLASH-1017' },
        ],
      }).success
    ).toBe(false);
  });

  it('只设派单方式或价格带也算有效规则', () => {
    expect(
      LlmProviderRoutingConfigSchema.safeParse({
        rules: [],
        surplus_rules: [
          {
            ...surplusRule,
            preferred_providers: [],
            min_discount_pct: null,
            route_objective: 'latency',
          },
        ],
      }).success
    ).toBe(true);
  });
});
