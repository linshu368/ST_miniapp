import { describe, expect, it } from 'vitest';
import { ModelCatalogSchema, type ModelCatalog } from '@miniapp/shared';
import { EditableModelCatalogSchema } from '../lib/configSchemas';
import {
  applyModelMarkup,
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
          openrouter_model_id: 'vendor/flash',
          display_name: 'Flash',
          tagline: '快速响应',
          price_input: 0.1,
          price_output: 0.2,
          markup: 2.5,
          enabled: true,
          sort_order: 7,
        },
        {
          id: 'economy',
          openrouter_model_id: 'vendor/economy',
          display_name: 'Economy',
          tagline: '节省星尘',
          price_input: 0.1,
          price_output: 0.1,
          markup: 2,
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
          openrouter_model_id: 'vendor/pro',
          display_name: 'Pro',
          tagline: '细腻演绎',
          price_input: 1,
          price_output: 2,
          markup: 4,
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
  it('keeps a newly added incomplete model editable', () => {
    const result = appendDraftModel(catalog, 0, 123);
    expect(result.tiers[0]?.models.at(-1)?.id).toBe('model-123-2');
    expect(EditableModelCatalogSchema.safeParse(result).success).toBe(true);
    expect(ModelCatalogSchema.safeParse(result).success).toBe(false);
  });

  it('keeps a newly added empty tier editable', () => {
    const result = appendDraftTier(catalog);
    expect(result.tiers.map((tier) => tier.tier)).toEqual(['light', 'premium', 'standard']);
    expect(result.tiers.at(-1)?.models).toEqual([]);
    expect(EditableModelCatalogSchema.safeParse(result).success).toBe(true);
    expect(ModelCatalogSchema.safeParse(result).success).toBe(false);
  });
});

describe('applyModelMarkup', () => {
  it('forces both display prices to zero for a free model', () => {
    const model = catalog.tiers[0]!.models[0]!;
    expect(applyModelMarkup(model, 0)).toMatchObject({
      markup: 0,
      price_input: 0,
      price_output: 0,
      deduct_markup: 2.5,
    });
  });

  it('applies recalculated prices and removes deduct markup for a paid model', () => {
    const model = {
      ...catalog.tiers[0]!.models[0]!,
      markup: 0 as const,
      deduct_markup: 3 as const,
    };
    const result = applyModelMarkup(model, 2, { price_input: 1.2, price_output: 3.4 });
    expect(result).toMatchObject({
      markup: 2,
      price_input: 1.2,
      price_output: 3.4,
    });
    expect(result).not.toHaveProperty('deduct_markup');
  });
});

describe('mergeModelUpdate', () => {
  it('does not keep deduct_markup when a free model becomes paid via shallow patch merge', () => {
    const freeModel = {
      ...catalog.tiers[0]!.models[0]!,
      markup: 0 as const,
      price_input: 0,
      price_output: 0,
      deduct_markup: 3 as const,
    };
    const result = mergeModelUpdate(freeModel, applyModelMarkup(freeModel, 1));
    expect(result.markup).toBe(1);
    expect(result).not.toHaveProperty('deduct_markup');
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
    duplicateCatalog.tiers[1]!.models[0]!.openrouter_model_id = 'vendor/flash';

    expect(findDuplicateOpenRouterAssignments(duplicateCatalog)).toEqual({
      'vendor/flash': [
        { stableId: 'flash', displayName: 'Flash', tier: 'light' },
        { stableId: 'pro', displayName: 'Pro', tier: 'premium' },
      ],
    });
  });

  it('ignores unique and incomplete model mappings', () => {
    const incompleteCatalog = appendDraftModel(catalog, 0, 456);
    expect(findDuplicateOpenRouterAssignments(incompleteCatalog)).toEqual({});
  });
});
