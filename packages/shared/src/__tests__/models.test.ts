import { describe, expect, it } from 'vitest';
import {
  LlmPricingConfigSchema,
  ModelCatalogSchema,
  resolveEffectiveSelectedModelId,
  resolveEnabledCatalogModel,
  resolveRuntimeCatalogModel,
  toPublicModelCatalog,
} from '../api/models.js';

describe('LlmPricingConfigSchema', () => {
  it('validates fixed per-round deductions', () => {
    expect(
      LlmPricingConfigSchema.parse({
        fixedDeduction: {
          freeQuotaExhausted: 10,
          light: 15,
          standard: 30,
          premium: 50,
        },
      }).fixedDeduction
    ).toEqual({ freeQuotaExhausted: 10, light: 15, standard: 30, premium: 50 });
  });

  it('strips leftover exchangeRate and markup fields', () => {
    expect(
      LlmPricingConfigSchema.parse({
        exchangeRate: 680,
        markup: 2.5,
        fixedDeduction: {
          freeQuotaExhausted: 10,
          light: 15,
          standard: 30,
          premium: 50,
        },
      })
    ).toEqual({
      fixedDeduction: {
        freeQuotaExhausted: 10,
        light: 15,
        standard: 30,
        premium: 50,
      },
    });
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
          is_free: false,
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

  it('rejects long taglines', () => {
    const invalidCatalog = structuredClone(validCatalog);
    const model = invalidCatalog.tiers[0]?.models[0];
    if (!model) throw new Error('test fixture must include a model');
    model.tagline = 'x'.repeat(41);

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

  it('enforces stable ids, required taglines and hex colors', () => {
    const invalidCatalog = structuredClone(validCatalog);
    invalidCatalog.tiers[0]!.color = 'purple';
    invalidCatalog.tiers[0]!.models[0]!.id = 'Vendor/Model';
    invalidCatalog.tiers[0]!.models[0]!.tagline = '';
    expect(ModelCatalogSchema.safeParse(invalidCatalog).success).toBe(false);
  });

  it('accepts free and paid models', () => {
    const valid = structuredClone(validCatalog);
    valid.tiers[0]!.models[0]!.is_free = true;
    expect(ModelCatalogSchema.safeParse(valid).success).toBe(true);
    valid.tiers[0]!.models[0]!.is_free = false;
    expect(ModelCatalogSchema.safeParse(valid).success).toBe(true);
  });

  it('maps leftover markup 0 to is_free and drops markup fields', () => {
    const legacy = structuredClone(validCatalog) as {
      tiers: Array<{ models: Array<Record<string, unknown>> }>;
    };
    const model = legacy.tiers[0]!.models[0]!;
    delete model.is_free;
    model.markup = 0;
    model.deduct_markup = 2.5;

    const parsed = ModelCatalogSchema.parse(legacy);
    expect(parsed.tiers[0]!.models[0]).toMatchObject({ is_free: true });
    expect(parsed.tiers[0]!.models[0]).not.toHaveProperty('markup');
    expect(parsed.tiers[0]!.models[0]).not.toHaveProperty('deduct_markup');
  });

  it('maps leftover nonzero markup to a paid model', () => {
    const legacy = structuredClone(validCatalog) as {
      tiers: Array<{ models: Array<Record<string, unknown>> }>;
    };
    const model = legacy.tiers[0]!.models[0]!;
    delete model.is_free;
    model.markup = 2.5;

    expect(ModelCatalogSchema.parse(legacy).tiers[0]!.models[0]!.is_free).toBe(false);
  });
});

describe('OpenRouter model helpers', () => {
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
    expect(publicCatalog.tiers[0]?.models[0]?.is_free).toBe(false);
  });

  it('marks free public models', () => {
    const freeCatalog = structuredClone(validCatalog);
    Object.assign(freeCatalog.tiers[0]!.models[0]!, { is_free: true });
    const publicModel = toPublicModelCatalog(ModelCatalogSchema.parse(freeCatalog)).tiers[0]!
      .models[0]!;
    expect(publicModel).toMatchObject({ is_free: true });
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
});
