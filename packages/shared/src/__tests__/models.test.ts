import { describe, expect, it } from 'vitest';
import {
  calculateDisplayPrice,
  ModelCatalogSchema,
  resolveEnabledCatalogModel,
} from '../api/models.js';

const validCatalog = {
  default_model_id: 'flash',
  tiers: [
    {
      tier: 'light',
      label: 'Light',
      color: '#ffffff',
      cost_hint: 'Low cost',
      sort_order: 0,
      models: [
        {
          id: 'flash',
          openrouter_model_id: 'google/gemini-flash',
          display_name: 'Gemini Flash',
          tagline: 'Fast',
          price_input: 0.1,
          price_output: 0.2,
          enabled: true,
          sort_order: 0,
        },
      ],
    },
  ],
};

describe('ModelCatalogSchema', () => {
  it('accepts a catalog whose default identifies a model', () => {
    expect(ModelCatalogSchema.safeParse(validCatalog).success).toBe(true);
  });

  it('rejects an unknown default model id', () => {
    expect(
      ModelCatalogSchema.safeParse({ ...validCatalog, default_model_id: 'missing' }).success
    ).toBe(false);
  });

  it('rejects a disabled default model and duplicate tier keys', () => {
    const disabledDefault = structuredClone(validCatalog);
    disabledDefault.tiers[0]!.models[0]!.enabled = false;
    expect(ModelCatalogSchema.safeParse(disabledDefault).success).toBe(false);

    const duplicateTier = structuredClone(validCatalog);
    duplicateTier.tiers.push({
      ...structuredClone(duplicateTier.tiers[0]!),
      models: [
        {
          ...structuredClone(duplicateTier.tiers[0]!.models[0]!),
          id: 'another-model',
          openrouter_model_id: 'vendor/another-model',
        },
      ],
    });
    expect(ModelCatalogSchema.safeParse(duplicateTier).success).toBe(false);
  });

  it('rejects long taglines and negative display prices', () => {
    const invalidCatalog = structuredClone(validCatalog);
    const model = invalidCatalog.tiers[0]?.models[0];
    if (!model) throw new Error('test fixture must include a model');
    model.tagline = '1234567890123456';
    model.price_input = -1;

    expect(ModelCatalogSchema.safeParse(invalidCatalog).success).toBe(false);
  });

  it('rejects duplicate OpenRouter model mappings', () => {
    const duplicateMapping = structuredClone(validCatalog);
    duplicateMapping.tiers[0]!.models.push({
      ...structuredClone(duplicateMapping.tiers[0]!.models[0]!),
      id: 'another-stable-id',
    });

    expect(ModelCatalogSchema.safeParse(duplicateMapping).success).toBe(false);
  });
});

describe('OpenRouter model helpers', () => {
  it('converts USD per-token pricing into one-decimal star pricing per 10k tokens', () => {
    expect(
      calculateDisplayPrice(0.0000004, {
        exchangeRate: 680,
        markup: 2.5,
      })
    ).toBe(6.8);
  });

  it('resolves enabled stable ids and rejects unknown or disabled models', () => {
    const catalog = ModelCatalogSchema.parse(validCatalog);
    expect(resolveEnabledCatalogModel(catalog, 'flash').openrouter_model_id).toBe(
      'google/gemini-flash'
    );
    expect(() => resolveEnabledCatalogModel(catalog, 'missing')).toThrow('unknown model id');

    const disabledCatalog = structuredClone(catalog);
    disabledCatalog.tiers[0]!.models[0]!.enabled = false;
    expect(() => resolveEnabledCatalogModel(disabledCatalog, 'flash')).toThrow('model is disabled');
  });
});
