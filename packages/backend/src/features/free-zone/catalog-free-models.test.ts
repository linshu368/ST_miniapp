import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FreeZoneConfigSchema, ModelCatalogSchema, type ModelCatalog } from '@miniapp/shared';
import type { LlmPricingConfig } from '../../platform/model-tiers.js';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  catalog: vi.fn(),
  states: vi.fn(),
}));
vi.mock('./config.js', () => ({ fetchFreeZoneConfig: mocks.config }));
vi.mock('../../platform/model-tiers.js', () => ({ fetchModelCatalogSnapshot: mocks.catalog }));
vi.mock('./repository.js', () => ({ loadFreeZoneStates: mocks.states }));

import { buildFreeZoneResolvedModel } from './resolved-model.js';
import {
  findCandidate,
  getFreeZoneSnapshot,
  invalidateFreeZoneSnapshot,
  type FreeZoneSnapshot,
} from './snapshot.js';

const tierModel = {
  id: 'ds-1017',
  provider: 'openrouter',
  provider_model_id: 'deepseek/deepseek-v4.1-flash-1017',
  openrouter_model_id: 'deepseek/deepseek-v4.1-flash-1017',
  display_name: 'DeepSeek',
  tagline: '稳',
  is_free: false,
  enabled: true,
  sort_order: 0,
};

function catalogWith(freeZoneModels: unknown[]): ModelCatalog {
  return ModelCatalogSchema.parse({
    default_model_id: 'ds-1017',
    first_token_deadline_ms: 9000,
    tiers: [
      {
        tier: 'light',
        label: '轻量',
        color: '#4ade80',
        cost_hint: '15',
        sort_order: 0,
        models: [tierModel],
      },
    ],
    free_zone_models: freeZoneModels,
  });
}

const veniceModel = {
  id: 'free-venice-glm',
  provider: 'venice',
  provider_model_id: 'zai-org-glm-5',
  display_name: 'GLM 5',
  family: 'glm',
  benchmark_tier: 'standard',
  first_token_timeout_ms: 5000,
};
const routerModel = {
  id: 'free-or-qwen',
  provider: 'openrouter',
  provider_model_id: 'qwen/qwen3.6-plus',
  display_name: 'Qwen',
  family: 'qwen',
  benchmark_tier: 'premium',
};

describe('catalog free_zone_models schema', () => {
  it('defaults to an empty section and fills field defaults', () => {
    expect(catalogWith([]).free_zone_models).toEqual([]);
    const [model] = catalogWith([routerModel]).free_zone_models ?? [];
    expect(model).toMatchObject({ tagline: '', enabled: true, first_token_timeout_ms: 4000 });
  });

  it.each([
    ['a Surplus model', { ...routerModel, provider: 'surplus' }, 'Surplus'],
    ['an id without free-', { ...routerModel, id: 'qwen' }, 'free-'],
    ['a malformed OpenRouter id', { ...routerModel, provider_model_id: 'qwen' }, 'vendor/model'],
    ['a fallback wait over the deadline', { ...veniceModel, first_token_timeout_ms: 9000 }, '短于'],
  ])('rejects %s', (_, model, message) => {
    expect(() => catalogWith([model])).toThrow(message);
  });

  it('rejects duplicate ids and duplicate upstream models', () => {
    expect(() => catalogWith([routerModel, { ...routerModel, provider_model_id: 'a/b' }])).toThrow(
      'id 重复'
    );
    expect(() => catalogWith([routerModel, { ...routerModel, id: 'free-other' }])).toThrow(
      '只能加一次'
    );
  });
});

const zoneConfig = FreeZoneConfigSchema.parse({
  enabled: true,
  period: { starts_at: '2026-11-11T00:00:00+08:00', ends_at: '2026-11-30T00:00:00+08:00' },
  candidates: [
    {
      id: 'free-gemini-3-8-flash',
      surplus_model: 'gemini-3.8-flash',
      display_name: 'Gemini 3.8 Flash',
      family: 'gemini',
      benchmark_tier: 'standard',
    },
  ],
});

describe('free zone snapshot with catalog models', () => {
  beforeEach(() => {
    invalidateFreeZoneSnapshot();
    mocks.config.mockResolvedValue(zoneConfig);
    mocks.states.mockResolvedValue(
      new Map([['free-gemini-3-8-flash', { status: 'listed', providers: ['google'] }]])
    );
  });

  it('lists Surplus models first, then enabled catalog models, skipping clashing ids', async () => {
    mocks.catalog.mockResolvedValue({
      version: 7,
      catalog: catalogWith([
        routerModel,
        { ...veniceModel, enabled: false },
        { ...veniceModel, id: 'free-gemini-3-8-flash', provider_model_id: 'other' },
      ]),
    });
    const snapshot = await getFreeZoneSnapshot();
    expect(snapshot?.listed.map((item) => [item.source, item.candidate.id])).toEqual([
      ['surplus', 'free-gemini-3-8-flash'],
      ['catalog', 'free-or-qwen'],
    ]);
    // 停用的不在架，但下架后找同系列替换时仍认得它
    expect(findCandidate(snapshot, 'free-venice-glm')?.family).toBe('glm');
  });

  it('shows catalog models even with an empty Surplus pool', async () => {
    mocks.config.mockResolvedValue({ ...zoneConfig, candidates: [] });
    mocks.catalog.mockResolvedValue({ version: 7, catalog: catalogWith([veniceModel]) });
    const snapshot = await getFreeZoneSnapshot();
    expect(snapshot?.listed.map((item) => item.candidate.id)).toEqual(['free-venice-glm']);
  });
});

describe('buildFreeZoneResolvedModel for a catalog model', () => {
  it('takes the paid-catalog path: one primary plus fallback, billed as free zone', () => {
    const catalog = catalogWith([veniceModel]);
    const candidate = catalog.free_zone_models![0]!;
    const zone: FreeZoneSnapshot = {
      config: zoneConfig,
      listed: [{ source: 'catalog', candidate }],
      catalogModels: [candidate],
    };
    const model = buildFreeZoneResolvedModel({
      listed: zone.listed[0]!,
      zone,
      catalogSnapshot: { catalog, version: 7 },
      pricing: {
        fixedDeduction: { freeQuotaExhausted: 15, light: 15, standard: 33, premium: 55 },
      } as LlmPricingConfig,
      entitlement: { active: false, validUntil: null },
    });
    expect(model).toMatchObject({
      modelId: 'free-venice-glm',
      provider: 'venice',
      providerModelId: 'zai-org-glm-5',
      billingContext: {
        provider: 'venice',
        freeZone: { candidateId: 'free-venice-glm', originalCredits: 33 },
      },
      firstTokenPolicy: { timeoutMs: 5000, deadlineMs: 9000, catalogVersion: 7 },
    });
    // 没有 Surplus 的折扣底线、供应商白名单、并发和派不出去计数
    expect(model.freeZone).toBeUndefined();
  });
});
