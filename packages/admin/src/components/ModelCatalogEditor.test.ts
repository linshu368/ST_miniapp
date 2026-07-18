import { describe, expect, it } from 'vitest';
import { ModelCatalogSchema, type ModelCatalog } from '@miniapp/shared';
import { EditableModelCatalogSchema } from '../lib/configSchemas';
import { appendDraftModel, appendDraftTier, reorderCatalog } from './ModelCatalogEditor';

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
