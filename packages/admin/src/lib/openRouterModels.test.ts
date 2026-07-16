import { describe, expect, it } from 'vitest';
import type { ModelCatalog, OpenRouterModelDirectory } from '@miniapp/shared';
import { calculateModelDisplayPrices, getOpenRouterCatalogIssues } from './openRouterModels';

const upstream = {
  id: 'google/gemini-flash',
  canonical_slug: 'google/gemini-flash',
  name: 'Gemini Flash',
  description: null,
  context_length: 1_000_000,
  prompt_usd_per_token: 0.0000004,
  completion_usd_per_token: 0.0000012,
  expiration_date: null,
};

const directory: OpenRouterModelDirectory = {
  models: [upstream],
  fetched_at: '2026-07-17T00:00:00.000Z',
  stale: false,
};

const catalog: ModelCatalog = {
  default_model_id: 'flash',
  tiers: [
    {
      tier: 'light',
      label: '轻量',
      color: '#4ade80',
      cost_hint: '日常对话',
      sort_order: 1,
      models: [
        {
          id: 'flash',
          openrouter_model_id: upstream.id,
          display_name: 'Gemini Flash',
          tagline: '轻巧流畅',
          price_input: 0,
          price_output: 0,
          enabled: true,
          sort_order: 1,
        },
      ],
    },
  ],
};

describe('OpenRouter admin helpers', () => {
  it('calculates editable display prices from the current pricing config', () => {
    expect(calculateModelDisplayPrices(upstream, { exchangeRate: 680, markup: 2.5 })).toEqual({
      price_input: 6.8,
      price_output: 20.4,
    });
  });

  it('accepts known models and reports missing models', () => {
    expect(getOpenRouterCatalogIssues(catalog, directory)).toEqual([]);

    const unknown = structuredClone(catalog);
    unknown.tiers[0]!.models[0]!.openrouter_model_id = 'vendor/missing';
    expect(getOpenRouterCatalogIssues(unknown, directory)).toEqual([
      'Gemini Flash：OpenRouter ID 不存在',
    ]);
  });

  it('reports expired OpenRouter models', () => {
    const expiredDirectory = structuredClone(directory);
    expiredDirectory.models[0]!.expiration_date = '2026-07-01T00:00:00.000Z';

    expect(
      getOpenRouterCatalogIssues(catalog, expiredDirectory, Date.parse('2026-07-17T00:00:00.000Z'))
    ).toEqual(['Gemini Flash：OpenRouter 模型已过期']);
  });
});
