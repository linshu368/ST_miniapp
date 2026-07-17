import { describe, expect, it } from 'vitest';
import {
  LEGACY_MODEL_TAGLINE,
  legacyTiersToCatalog,
  shouldReuseCatalogCache,
} from './model-tiers.js';
import { ModelCatalogModelSchema } from '@miniapp/shared';

describe('model catalog runtime helpers', () => {
  it('turns provider slugs into separate stable ids for legacy fallback', () => {
    const catalog = legacyTiersToCatalog([
      {
        tier: 'standard',
        modelName: 'google/gemini-flash',
        provider: 'openrouter',
        label: 'Gemini Flash',
        deductionRate: 1,
        isDefault: true,
      },
    ]);

    expect(catalog.default_model_id).toBe('google-gemini-flash');
    expect(catalog.tiers[0]?.models[0]?.openrouter_model_id).toBe('google/gemini-flash');
  });

  it('invalidates the cache whenever runtime_config.version changes', () => {
    expect(shouldReuseCatalogCache(4, 4)).toBe(true);
    expect(shouldReuseCatalogCache(4, 5)).toBe(false);
  });

  it('keeps the legacy compatibility tagline valid against the formal schema', () => {
    expect(ModelCatalogModelSchema.shape.tagline.parse(LEGACY_MODEL_TAGLINE)).toBe('经典模型');
  });
});
