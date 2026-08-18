import { describe, expect, it } from 'vitest';
import type { GetModelCatalogData } from '@miniapp/shared';
import { applySelectedModelToCatalog } from './models';
import { MODEL_CATALOG_STALE_TIME_MS, shouldRefreshModelCatalog } from './model-cache-policy';

const catalog: GetModelCatalogData = {
  catalog: {
    default_model_id: 'flash',
    tiers: [
      {
        key: 'light',
        label: '轻量',
        color: '#ffffff',
        cost_hint: '低消耗',
        sort_order: 0,
        models: [
          {
            id: 'flash',
            display_name: 'Flash',
            tagline: '快',
            is_free: true,
            sort_order: 0,
          },
          {
            id: 'pro',
            display_name: 'Pro',
            tagline: '强',
            is_free: false,
            sort_order: 1,
          },
        ],
      },
    ],
  },
  selected_model_id: 'flash',
  selected_openrouter_model_id: 'google/gemini-flash',
  catalog_version: 1,
};

describe('model catalog refresh policy', () => {
  it('refreshes missing and older-than-five-minute data only', () => {
    const now = 1_000_000;
    expect(shouldRefreshModelCatalog(0, now)).toBe(true);
    expect(shouldRefreshModelCatalog(now - MODEL_CATALOG_STALE_TIME_MS, now)).toBe(false);
    expect(shouldRefreshModelCatalog(now - MODEL_CATALOG_STALE_TIME_MS - 1, now)).toBe(true);
  });
});

describe('applySelectedModelToCatalog', () => {
  it('leaves undefined catalogs untouched', () => {
    expect(applySelectedModelToCatalog(undefined, { model_id: 'pro' })).toBeUndefined();
  });

  it('optimistically switches selected_model_id without requiring the provider id', () => {
    const next = applySelectedModelToCatalog(catalog, { model_id: 'pro' });
    expect(next).toEqual({
      ...catalog,
      selected_model_id: 'pro',
    });
  });

  it('fills in the provider id after the select response lands', () => {
    const next = applySelectedModelToCatalog(catalog, {
      model_id: 'pro',
      openrouter_model_id: 'google/gemini-pro',
    });
    expect(next).toEqual({
      ...catalog,
      selected_model_id: 'pro',
      selected_openrouter_model_id: 'google/gemini-pro',
    });
  });

  it('returns the same object when the selection is already applied', () => {
    expect(applySelectedModelToCatalog(catalog, { model_id: 'flash' })).toBe(catalog);
  });
});
