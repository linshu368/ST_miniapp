import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FreeZoneConfigSchema, ModelCatalogSchema } from '@miniapp/shared';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  catalog: vi.fn(),
  states: vi.fn(),
  usage: vi.fn(),
}));
vi.mock('./config.js', () => ({ fetchFreeZoneConfig: mocks.config }));
vi.mock('../../platform/model-tiers.js', () => ({ fetchModelCatalogSnapshot: mocks.catalog }));
vi.mock('./repository.js', () => ({
  loadFreeZoneStates: mocks.states,
  loadFreeZoneTurnUsage: mocks.usage,
}));
vi.mock('../generation/creator-billing.js', () => ({ getCharacterCreatorOwner: vi.fn() }));

import { resolveCatalogFreeZone, settleFreeZoneSelection } from './selection.js';
import { getFreeZoneSnapshot, invalidateFreeZoneSnapshot } from './snapshot.js';
import { createFreeZoneUsageLoader, listedTurnLimits } from './usage-limit.js';

const candidate = (id: string, family: string, turns_per_24h: number | null = null) => ({
  id,
  surplus_model: id.replace('free-', ''),
  display_name: id,
  family,
  benchmark_tier: 'standard',
  turns_per_24h,
});

const catalog = ModelCatalogSchema.parse({
  default_model_id: 'ds-1017',
  first_token_deadline_ms: 9000,
  tiers: [
    {
      tier: 'light',
      label: '轻量',
      color: '#4ade80',
      cost_hint: '15',
      sort_order: 0,
      models: [
        {
          id: 'ds-1017',
          provider: 'openrouter',
          provider_model_id: 'deepseek/deepseek-v4.1-flash-1017',
          openrouter_model_id: 'deepseek/deepseek-v4.1-flash-1017',
          display_name: 'DeepSeek 1017',
          tagline: '稳',
          is_free: false,
          enabled: true,
          sort_order: 0,
        },
      ],
    },
  ],
  free_zone_models: [
    {
      id: 'free-or-qwen',
      provider: 'openrouter',
      provider_model_id: 'qwen/qwen3.6-plus',
      display_name: 'Qwen',
      family: 'qwen',
      benchmark_tier: 'standard',
      turns_per_24h: 50,
    },
  ],
});

const zoneConfig = FreeZoneConfigSchema.parse({
  enabled: true,
  period: { starts_at: '2026-11-11T00:00:00+08:00', ends_at: '2026-11-30T00:00:00+08:00' },
  usage_limit: { turns_per_24h: 100 },
  candidates: [
    candidate('free-gemini-3-8-flash', 'gemini', 200),
    candidate('free-gemini-3-1-flash-lite', 'gemini'),
    candidate('free-deepseek-v4-pro', 'deepseek'),
  ],
});

const RESET = '2026-11-18T12:00:00.000Z';
const NOW = new Date('2026-11-18T08:00:00Z');

function base() {
  return {
    userId: 'u1',
    characterId: null,
    catalog,
    isOwnCard: true,
    loadFacts: async () => null,
    now: NOW,
  };
}

/** 这些模型用满了，其余没用 */
function exhaust(...ids: string[]) {
  mocks.usage.mockResolvedValue(new Map(ids.map((id) => [id, { turns: 999, resetsAt: RESET }])));
}

beforeEach(() => {
  invalidateFreeZoneSnapshot();
  mocks.usage.mockReset();
  mocks.config.mockResolvedValue(zoneConfig);
  mocks.catalog.mockResolvedValue({ version: 7, catalog });
  mocks.states.mockResolvedValue(
    new Map(
      zoneConfig.candidates.map((item) => [item.id, { status: 'listed', providers: ['google'] }])
    )
  );
});

describe('listedTurnLimits', () => {
  it('uses the model limit, falls back to the global one, and skips unlimited models', async () => {
    const snapshot = (await getFreeZoneSnapshot())!;
    expect(listedTurnLimits(snapshot)).toEqual([
      { modelId: 'free-gemini-3-8-flash', limit: 200 },
      { modelId: 'free-gemini-3-1-flash-lite', limit: 100 },
      { modelId: 'free-deepseek-v4-pro', limit: 100 },
      { modelId: 'free-or-qwen', limit: 50 },
    ]);
    const unlimited = {
      ...snapshot,
      config: { ...snapshot.config, usage_limit: { turns_per_24h: null } },
    };
    expect(listedTurnLimits(unlimited).map((item) => item.modelId)).toEqual([
      'free-gemini-3-8-flash',
      'free-or-qwen',
    ]);
  });
});

describe('createFreeZoneUsageLoader', () => {
  it('marks only models at or over their limit, and queries once per request', async () => {
    const snapshot = (await getFreeZoneSnapshot())!;
    mocks.usage.mockResolvedValue(
      new Map([
        ['free-gemini-3-8-flash', { turns: 199, resetsAt: null }],
        ['free-or-qwen', { turns: 50, resetsAt: RESET }],
      ])
    );
    const load = createFreeZoneUsageLoader('u1');
    expect([...(await load(snapshot))]).toEqual([['free-or-qwen', RESET]]);
    await load(snapshot);
    expect(mocks.usage).toHaveBeenCalledTimes(1);
  });

  it('treats a failed query as nothing used up', async () => {
    const snapshot = (await getFreeZoneSnapshot())!;
    mocks.usage.mockRejectedValue(new Error('db down'));
    expect((await createFreeZoneUsageLoader('u1')(snapshot)).size).toBe(0);
  });
});

describe('selection with the 24-hour limit', () => {
  const settle = (persistedModelId: string, enforceLimit?: boolean) =>
    settleFreeZoneSelection({
      ...base(),
      persistedModelId,
      loadUsage: createFreeZoneUsageLoader('u1'),
      enforceLimit,
    });

  it('keeps a model that is not used up', async () => {
    exhaust('free-deepseek-v4-pro');
    const settled = await settle('free-gemini-3-8-flash');
    expect(settled.replacement).toBeNull();
    expect(settled.usable?.listed.candidate.id).toBe('free-gemini-3-8-flash');
  });

  it('switches a used-up model to the same family first', async () => {
    exhaust('free-gemini-3-8-flash');
    const settled = await settle('free-gemini-3-8-flash');
    expect(settled.modelId).toBe('free-gemini-3-1-flash-lite');
    expect(settled.usable?.listed.candidate.id).toBe('free-gemini-3-1-flash-lite');
    expect(settled.replacement).toEqual({
      fromName: 'free-gemini-3-8-flash',
      toName: 'free-gemini-3-1-flash-lite',
      reason: 'limit_reached',
      toPaid: false,
      resetsAt: RESET,
    });
  });

  it('falls back to another family, then to the paid default when all are used up', async () => {
    exhaust('free-gemini-3-8-flash', 'free-gemini-3-1-flash-lite', 'free-or-qwen');
    expect((await settle('free-gemini-3-8-flash')).modelId).toBe('free-deepseek-v4-pro');

    invalidateFreeZoneSnapshot();
    exhaust(...zoneConfig.candidates.map((item) => item.id), 'free-or-qwen');
    const settled = await settle('free-gemini-3-8-flash');
    expect(settled).toMatchObject({
      usable: null,
      modelId: 'ds-1017',
      replacement: { reason: 'limit_reached', toPaid: true, toName: 'DeepSeek 1017' },
    });
  });

  it('never replaces a delisted model with a used-up one', async () => {
    exhaust('free-gemini-3-1-flash-lite');
    const settled = await settle('free-gemini-old');
    expect(settled.replacement?.reason).toBe('delisted');
    expect(settled.modelId).not.toBe('free-gemini-3-1-flash-lite');
  });

  it('only marks used-up models in the catalog, without switching the selection', async () => {
    exhaust('free-gemini-3-8-flash');
    const result = await resolveCatalogFreeZone({
      ...base(),
      settingsModelId: 'free-gemini-3-8-flash',
      pricing: { freeQuotaExhausted: 15, light: 15, standard: 33, premium: 55 },
      loadUsage: createFreeZoneUsageLoader('u1'),
    });
    expect(result.replacement).toBeNull();
    expect(result.usable?.candidate.id).toBe('free-gemini-3-8-flash');
    expect(
      result.view?.models.map((model) => [model.id, model.limited, model.limit_resets_at])
    ).toEqual([
      ['free-gemini-3-8-flash', true, RESET],
      ['free-gemini-3-1-flash-lite', true, null],
      ['free-deepseek-v4-pro', true, null],
      ['free-or-qwen', true, null],
    ]);
    expect(mocks.usage).toHaveBeenCalledTimes(1);
  });
});
