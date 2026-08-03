import { describe, expect, it } from 'vitest';
import {
  calculateDisplayPrice,
  LlmPricingConfigSchema,
  ModelCatalogSchema,
  resolveEffectiveSelectedModelId,
  resolveEnabledCatalogModel,
  resolveRuntimeCatalogMarkup,
  resolveRuntimeCatalogModel,
  toPublicModelCatalog,
} from '../api/models.js';

describe('LlmPricingConfigSchema', () => {
  it('validates fixed per-round deductions', () => {
    expect(
      LlmPricingConfigSchema.parse({
        balanceBaseline: 30,
        fallbackCost: 30,
        exchangeRate: 680,
        markup: 2.5,
        fixedDeduction: {
          freeQuotaExhausted: 10,
          light: 15,
          standard: 30,
          premium: 50,
        },
      }).fixedDeduction
    ).toEqual({ freeQuotaExhausted: 10, light: 15, standard: 30, premium: 50 });
  });
});

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
          markup: 2.5,
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
    model.tagline = 'x'.repeat(41);
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

  it('enforces stable ids, required taglines, hex colors and one-decimal prices', () => {
    const invalidCatalog = structuredClone(validCatalog);
    invalidCatalog.tiers[0]!.color = 'purple';
    invalidCatalog.tiers[0]!.models[0]!.id = 'Vendor/Model';
    invalidCatalog.tiers[0]!.models[0]!.tagline = '';
    invalidCatalog.tiers[0]!.models[0]!.price_input = 0.12;
    expect(ModelCatalogSchema.safeParse(invalidCatalog).success).toBe(false);
  });

  it('accepts zero or half-step model markups from one through four', () => {
    const valid = structuredClone(validCatalog);
    Object.assign(valid.tiers[0]!.models[0]!, {
      markup: 0,
      price_input: 0,
      price_output: 0,
      deduct_markup: 2.5,
    });
    expect(ModelCatalogSchema.safeParse(valid).success).toBe(true);
    valid.tiers[0]!.models[0]!.markup = 3.5;
    delete (valid.tiers[0]!.models[0]! as { deduct_markup?: number }).deduct_markup;
    expect(ModelCatalogSchema.safeParse(valid).success).toBe(true);
    valid.tiers[0]!.models[0]!.markup = 3.2;
    expect(ModelCatalogSchema.safeParse(valid).success).toBe(false);
  });

  it('allows deduct markup only on free models', () => {
    const free = structuredClone(validCatalog);
    Object.assign(free.tiers[0]!.models[0]!, {
      markup: 0,
      price_input: 0,
      price_output: 0,
      deduct_markup: 3,
    });
    expect(ModelCatalogSchema.safeParse(free).success).toBe(true);

    Object.assign(free.tiers[0]!.models[0]!, { deduct_markup: 0 });
    expect(ModelCatalogSchema.safeParse(free).success).toBe(false);
    delete (free.tiers[0]!.models[0]! as { deduct_markup?: number }).deduct_markup;
    expect(ModelCatalogSchema.safeParse(free).success).toBe(false);

    const paid = structuredClone(validCatalog);
    Object.assign(paid.tiers[0]!.models[0]!, { deduct_markup: 2.5 });
    expect(ModelCatalogSchema.safeParse(paid).success).toBe(false);
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
    expect(calculateDisplayPrice(0.0000004, { exchangeRate: 680, markup: 0 })).toBe(0);
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

  it('projects a provider-safe public catalog', () => {
    const catalog = ModelCatalogSchema.parse(validCatalog);
    const publicCatalog = toPublicModelCatalog(catalog);

    expect(publicCatalog.tiers[0]?.key).toBe('light');
    expect(publicCatalog.tiers[0]?.models[0]).not.toHaveProperty('openrouter_model_id');
    expect(publicCatalog.tiers[0]?.models[0]).not.toHaveProperty('enabled');
    expect(publicCatalog.tiers[0]?.models[0]).not.toHaveProperty('markup');
    expect(publicCatalog.tiers[0]?.models[0]).not.toHaveProperty('deduct_markup');
    expect(publicCatalog.tiers[0]?.models[0]?.is_free).toBe(false);
  });

  it('forces free public model prices to zero', () => {
    const freeCatalog = structuredClone(validCatalog);
    Object.assign(freeCatalog.tiers[0]!.models[0]!, {
      markup: 0,
      price_input: 0,
      price_output: 0,
      deduct_markup: 2.5,
    });
    const publicModel = toPublicModelCatalog(ModelCatalogSchema.parse(freeCatalog)).tiers[0]!
      .models[0]!;
    expect(publicModel).toMatchObject({ is_free: true, price_input: 0, price_output: 0 });
  });

  it('falls back to the default when a stored selection is unavailable', () => {
    const catalog = ModelCatalogSchema.parse(validCatalog);
    expect(resolveEffectiveSelectedModelId(catalog, 'flash')).toBe('flash');
    expect(resolveEffectiveSelectedModelId(catalog, 'removed')).toBe('flash');
    expect(resolveEffectiveSelectedModelId(catalog, null)).toBe('flash');
  });

  it('resolves runtime mappings from catalogs that fail display-only validation', () => {
    const legacyDisplayCatalog = structuredClone(validCatalog);
    legacyDisplayCatalog.tiers[0]!.color = 'purple';
    legacyDisplayCatalog.tiers[0]!.models[0]!.tagline = '';
    legacyDisplayCatalog.tiers[0]!.models[0]!.price_input = 0.123;

    expect(ModelCatalogSchema.safeParse(legacyDisplayCatalog).success).toBe(false);
    expect(resolveRuntimeCatalogModel(legacyDisplayCatalog, 'flash', false)).toEqual({
      id: 'flash',
      openrouter_model_id: 'google/gemini-flash',
    });
  });

  it('never treats an unknown stable id as a provider model id', () => {
    expect(resolveRuntimeCatalogModel(validCatalog, 'vendor/unknown', false)).toBeNull();
    expect(resolveRuntimeCatalogModel(validCatalog, 'vendor/unknown')).toEqual({
      id: 'flash',
      openrouter_model_id: 'google/gemini-flash',
    });
  });

  it('resolves per-model markup and falls back for legacy catalogs', () => {
    expect(resolveRuntimeCatalogMarkup(validCatalog, 'google/gemini-flash', 1)).toBe(2.5);
    const legacy = structuredClone(validCatalog);
    delete (legacy.tiers[0]!.models[0]! as { markup?: number }).markup;
    expect(resolveRuntimeCatalogMarkup(legacy, 'google/gemini-flash', 3)).toBe(3);
  });
});
