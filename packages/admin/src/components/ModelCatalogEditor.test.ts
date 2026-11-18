import { describe, expect, it } from 'vitest';
import { ModelCatalogSchema, type ModelCatalog } from '@miniapp/shared';
import { EditableModelCatalogSchema } from '@miniapp/admin-client';
import { newFreeZoneModel } from './ModelCatalogFreeZoneSection';
import {
  appendDraftModel,
  appendDraftTier,
  findDuplicateOpenRouterAssignments,
  filterOpenRouterModels,
  mergeModelUpdate,
  reorderCatalog,
} from './ModelCatalogEditor';

const catalog: ModelCatalog = {
  default_model_id: 'flash',
  tiers: [
    {
      tier: 'light',
      label: '轻量',
      color: '#4ade80',
      cost_hint: '日常对话',
      sort_order: 9,
      models: [
        {
          id: 'flash',
          provider: 'openrouter',
          provider_model_id: 'vendor/flash',
          openrouter_model_id: 'vendor/flash',
          display_name: 'Flash',
          tagline: '快速响应',
          is_free: false,
          enabled: true,
          sort_order: 7,
        },
        {
          id: 'economy',
          provider: 'openrouter',
          provider_model_id: 'vendor/economy',
          openrouter_model_id: 'vendor/economy',
          display_name: 'Economy',
          tagline: '节省星尘',
          is_free: false,
          enabled: true,
          sort_order: 8,
        },
      ],
    },
    {
      tier: 'premium',
      label: '旗舰',
      color: '#c084fc',
      cost_hint: '复杂剧情',
      sort_order: 12,
      models: [
        {
          id: 'pro',
          provider: 'openrouter',
          provider_model_id: 'vendor/pro',
          openrouter_model_id: 'vendor/pro',
          display_name: 'Pro',
          tagline: '细腻演绎',
          is_free: false,
          enabled: true,
          sort_order: 4,
        },
      ],
    },
  ],
};

describe('reorderCatalog', () => {
  it('reorders tiers and recalculates every sort order', () => {
    const result = reorderCatalog(catalog, 'tier:premium', 'tier:light');
    expect(result.tiers.map((tier) => tier.tier)).toEqual(['premium', 'light']);
    expect(result.tiers.map((tier) => tier.sort_order)).toEqual([0, 1]);
  });

  it('reorders models within a tier while keeping the stable default id', () => {
    const result = reorderCatalog(catalog, 'model:flash', 'model:economy');
    expect(result.default_model_id).toBe('flash');
    expect(result.tiers[0]?.models.map((model) => model.id)).toEqual(['economy', 'flash']);
    expect(result.tiers[0]?.models.map((model) => model.sort_order)).toEqual([0, 1]);
  });
});

describe('editable model catalog additions', () => {
  it('preserves a Venice provider mapping while parsing editable state', () => {
    const veniceCatalog = structuredClone(catalog);
    Object.assign(veniceCatalog.tiers[0]!.models[0]!, {
      provider: 'venice',
      provider_model_id: 'venice-uncensored',
      openrouter_model_id: 'venice-uncensored',
    });

    const parsed = EditableModelCatalogSchema.parse(veniceCatalog);

    expect(parsed.tiers[0]?.models[0]).toMatchObject({
      provider: 'venice',
      provider_model_id: 'venice-uncensored',
      openrouter_model_id: 'venice-uncensored',
    });
  });

  it('preserves a Surplus provider mapping while parsing editable state', () => {
    const surplusCatalog = structuredClone(catalog);
    Object.assign(surplusCatalog.tiers[0]!.models[0]!, {
      provider: 'surplus',
      provider_model_id: 'anthropic/claude-haiku-5.5',
      openrouter_model_id: 'anthropic/claude-haiku-5.5',
    });

    const parsed = EditableModelCatalogSchema.parse(surplusCatalog);

    expect(parsed.tiers[0]?.models[0]).toMatchObject({
      provider: 'surplus',
      provider_model_id: 'anthropic/claude-haiku-5.5',
      openrouter_model_id: 'anthropic/claude-haiku-5.5',
    });
  });

  it('keeps a newly added incomplete model editable', () => {
    const result = appendDraftModel(catalog, 0, 123);
    expect(result.tiers[0]?.models.at(-1)?.id).toBe('model-123-2');
    expect(EditableModelCatalogSchema.safeParse(result).success).toBe(true);
    expect(ModelCatalogSchema.safeParse(result).success).toBe(false);
  });

  it('keeps a newly added free zone model through the editable parse', () => {
    // 编辑器按 EditableModelCatalogSchema 的解析结果渲染：漏掉这一块，点「添加免费模型」会没反应
    const added = { ...catalog, free_zone_models: [newFreeZoneModel(123)] };
    const parsed = EditableModelCatalogSchema.parse(added);
    expect(parsed.free_zone_models).toEqual([
      expect.objectContaining({ id: 'free-model-123', provider: 'openrouter', family: '' }),
    ]);
    // 还没选上游、没填系列，不能发布
    expect(ModelCatalogSchema.safeParse(added).success).toBe(false);
    const filled = {
      ...added,
      free_zone_models: [
        { ...newFreeZoneModel(123), provider_model_id: 'qwen/qwen3.6-plus', family: 'qwen' },
      ],
    };
    expect(ModelCatalogSchema.parse(filled).free_zone_models).toHaveLength(1);
  });

  it('keeps the 24-hour limit of a free zone model through the editable parse', () => {
    const limited = {
      ...catalog,
      free_zone_models: [
        {
          ...newFreeZoneModel(123),
          provider_model_id: 'qwen/qwen3.6-plus',
          family: 'qwen',
          turns_per_24h: 80,
        },
      ],
    };
    expect(EditableModelCatalogSchema.parse(limited).free_zone_models[0]?.turns_per_24h).toBe(80);
    expect(ModelCatalogSchema.parse(limited).free_zone_models?.[0]?.turns_per_24h).toBe(80);
    // 留空 = 用畅聊配置的全局上限
    expect(newFreeZoneModel(1).turns_per_24h).toBeNull();
  });

  it('keeps a newly added empty tier editable', () => {
    const result = appendDraftTier(catalog);
    expect(result.tiers.map((tier) => tier.tier)).toEqual(['light', 'premium', 'standard']);
    expect(result.tiers.at(-1)?.models).toEqual([]);
    expect(EditableModelCatalogSchema.safeParse(result).success).toBe(true);
    expect(ModelCatalogSchema.safeParse(result).success).toBe(false);
  });
});

describe('mergeModelUpdate', () => {
  it('applies a shallow model patch', () => {
    const result = mergeModelUpdate(catalog.tiers[0]!.models[0]!, { is_free: true });
    expect(result.is_free).toBe(true);
    expect(result.display_name).toBe('Flash');
  });
});

describe('filterOpenRouterModels', () => {
  const models = [
    {
      id: 'google/gemini-flash',
      canonical_slug: 'google/gemini-flash-latest',
      name: 'Gemini Flash',
      description: 'Fast multimodal model',
      context_length: 1_000_000,
      prompt_usd_per_token: 0.0000004,
      completion_usd_per_token: 0.0000012,
      expiration_date: null,
    },
    {
      id: 'deepseek/deepseek-v3',
      canonical_slug: null,
      name: 'DeepSeek V3',
      description: 'Reasoning and chat',
      context_length: 128_000,
      prompt_usd_per_token: 0.0000002,
      completion_usd_per_token: 0.0000008,
      expiration_date: null,
    },
  ];

  it('searches model name, id, description and canonical slug case-insensitively', () => {
    expect(filterOpenRouterModels(models, 'GEMINI')).toHaveLength(1);
    expect(filterOpenRouterModels(models, 'deepseek/')).toHaveLength(1);
    expect(filterOpenRouterModels(models, 'multimodal')).toHaveLength(1);
    expect(filterOpenRouterModels(models, 'flash-latest')).toHaveLength(1);
  });

  it('returns all models for a blank search and none for an unknown term', () => {
    expect(filterOpenRouterModels(models, '  ')).toHaveLength(2);
    expect(filterOpenRouterModels(models, 'missing')).toEqual([]);
  });
});

describe('findDuplicateOpenRouterAssignments', () => {
  it('reports every card sharing the same OpenRouter model across tiers', () => {
    const duplicateCatalog = structuredClone(catalog);
    duplicateCatalog.tiers[1]!.models[0]!.provider_model_id = 'vendor/flash';
    duplicateCatalog.tiers[1]!.models[0]!.openrouter_model_id = 'vendor/flash';

    expect(findDuplicateOpenRouterAssignments(duplicateCatalog)).toEqual({
      'openrouter:vendor/flash': [
        {
          stableId: 'flash',
          displayName: 'Flash',
          tier: 'light',
          provider: 'openrouter',
          providerModelId: 'vendor/flash',
        },
        {
          stableId: 'pro',
          displayName: 'Pro',
          tier: 'premium',
          provider: 'openrouter',
          providerModelId: 'vendor/flash',
        },
      ],
    });
  });

  it('ignores unique and incomplete model mappings', () => {
    const incompleteCatalog = appendDraftModel(catalog, 0, 456);
    expect(findDuplicateOpenRouterAssignments(incompleteCatalog)).toEqual({});
  });
});
