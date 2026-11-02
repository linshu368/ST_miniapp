import { describe, expect, it } from 'vitest';
import type {
  ModelCatalog,
  OpenRouterModelDirectory,
  ProviderModelDirectory,
} from '@miniapp/shared';
import {
  getCatalogProviderIssues,
  getOpenRouterCatalogIssues,
  getFallbackProviderIssues,
} from './openRouterModels';

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
      label: 'Light',
      color: '#4ade80',
      cost_hint: 'Daily chat',
      sort_order: 1,
      models: [
        {
          id: 'flash',
          provider: 'openrouter',
          provider_model_id: upstream.id,
          openrouter_model_id: upstream.id,
          display_name: 'Gemini Flash',
          tagline: 'Fast model',
          is_free: false,
          enabled: true,
          sort_order: 1,
        },
      ],
    },
  ],
};

describe('OpenRouter admin helpers', () => {
  it('requires a separate provider pair after changing fallback and rejects blocked preferences', () => {
    expect(getFallbackProviderIssues(catalog)).toEqual([]);
    expect(getFallbackProviderIssues({ ...catalog, fallback_model_id: 'vendor/new' })).toHaveLength(
      1
    );
    expect(
      getFallbackProviderIssues(catalog, {
        rules: [
          {
            openrouter_model_id: 'deepseek/deepseek-v4.1-flash-1017',
            blocked_providers: ['Together'],
            preferred_providers: [],
            note: '',
          },
        ],
      })
    ).toHaveLength(1);
  });
  it('accepts known models and reports missing models', () => {
    expect(getOpenRouterCatalogIssues(catalog, directory)).toEqual([]);

    const unknown = structuredClone(catalog);
    unknown.tiers[0]!.models[0]!.openrouter_model_id = 'vendor/missing';
    expect(getOpenRouterCatalogIssues(unknown, directory)).toEqual([
      'Gemini Flash: OpenRouter ID does not exist',
    ]);
  });

  it('reports expired OpenRouter models', () => {
    const expiredDirectory = structuredClone(directory);
    expiredDirectory.models[0]!.expiration_date = '2026-07-01T00:00:00.000Z';

    expect(
      getOpenRouterCatalogIssues(catalog, expiredDirectory, Date.parse('2026-07-17T00:00:00.000Z'))
    ).toEqual(['Gemini Flash: OpenRouter model is expired']);
  });
});

it('validates the configured fallback against the existing OpenRouter directory', () => {
  const providerDirectory: ProviderModelDirectory = {
    ...directory,
    provider: 'openrouter',
    models: [{ ...upstream, provider: 'openrouter', status: 'available', raw_status_label: null }],
  };
  const configured: ModelCatalog = {
    ...catalog,
    fallback_model_id: upstream.id,
    fallback_provider_routes: [
      { model_id: upstream.id, preferred_providers: ['google-vertex', 'google-ai-studio'] },
    ],
  };
  expect(getCatalogProviderIssues(configured, { openrouter: providerDirectory })).toEqual([]);
  expect(
    getCatalogProviderIssues(
      { ...configured, fallback_model_id: 'vendor/missing' },
      { openrouter: providerDirectory }
    )
  ).toContain('兜底模型：OpenRouter 模型 ID 不存在');
  const unavailable: ProviderModelDirectory = {
    ...providerDirectory,
    models: [{ ...providerDirectory.models[0]!, status: 'unavailable' }],
  };
  expect(getCatalogProviderIssues(configured, { openrouter: unavailable })).toContain(
    '兜底模型：所选型号当前不可用'
  );
});
