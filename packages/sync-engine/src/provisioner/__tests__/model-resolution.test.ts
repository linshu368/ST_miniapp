import { describe, expect, it } from 'vitest';
import { resolveProvisionModel } from '../model-resolution.js';

const displayInvalidCatalog = {
  default_model_id: 'default-model',
  tiers: [
    {
      tier: 'standard',
      label: '标准',
      color: 'purple',
      cost_hint: '',
      sort_order: 0,
      models: [
        {
          id: 'default-model',
          openrouter_model_id: 'vendor/default',
          display_name: 'Default',
          tagline: '',
          price_input: 0.123,
          price_output: 0,
          enabled: true,
          sort_order: 0,
        },
        {
          id: 'selected-model',
          openrouter_model_id: 'vendor/selected',
          display_name: 'Selected',
          tagline: '',
          price_input: 0,
          price_output: 0,
          enabled: true,
          sort_order: 1,
        },
      ],
    },
  ],
};

describe('resolveProvisionModel', () => {
  it('preserves the selected stable-id mapping when display validation fails', () => {
    expect(
      resolveProvisionModel({
        catalog: displayInvalidCatalog,
        selectedModelId: 'selected-model',
        legacyTiers: null,
      })
    ).toEqual({
      openrouterModelId: 'vendor/selected',
      strictCatalogInvalid: true,
    });
  });

  it('uses legacy default before a compatibility default when selection is unknown', () => {
    expect(
      resolveProvisionModel({
        catalog: displayInvalidCatalog,
        selectedModelId: 'removed-model',
        legacyTiers: [
          {
            modelName: 'legacy/default',
            isDefault: true,
          },
        ],
      }).openrouterModelId
    ).toBe('legacy/default');
  });

  it('uses the compatibility catalog default when legacy config is absent', () => {
    expect(
      resolveProvisionModel({
        catalog: displayInvalidCatalog,
        selectedModelId: null,
        legacyTiers: null,
      }).openrouterModelId
    ).toBe('vendor/default');
  });
});
