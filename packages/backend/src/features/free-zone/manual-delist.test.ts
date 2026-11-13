import { describe, expect, it } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG, FreeZoneConfigSchema } from '@miniapp/shared';
import {
  advanceState,
  delistManually,
  initialState,
  listManually,
  MANUAL_HOLD_UNTIL,
  type FreeZoneModelState,
} from './lifecycle.js';
import { delistFreeZoneModelNow, type DelistNowDeps } from './manual-delist.js';
import type { ManualDelistingOutcome } from './repository.js';
import type { ScreeningResult } from './screening.js';

const NOW = new Date('2026-11-13T08:00:00.000Z');

const listedGlm: FreeZoneModelState = {
  ...initialState('free-glm-5'),
  status: 'listed',
  providers: ['zai'],
  providerSince: '2026-11-12T08:39:13.031Z',
  consecutivePasses: 2,
  excludedProviders: { other: '2026-11-14T00:00:00.000Z' },
  businessDelistsAt: ['2026-11-12T07:52:39.254Z'],
};

/** 官方数据一直达标：用来确认手动下架的模型不会被评估自动加回来 */
const passing: ScreeningResult = {
  pass: true,
  qualified: [{ provider: 'zai', price: 1000, ttftP50Ms: 1670, qualifiedOffers: 5 }],
  reasons: [],
  realized7dDiscountPct: 90,
  modelCheck: { key: 'min_realized_discount_pct', value: 90, threshold: null, pass: null },
  detail: [],
};

describe('delistManually', () => {
  it('takes the model off now and holds it, keeping business history and exclusions', () => {
    const { state, event } = delistManually({ state: listedGlm });
    expect(state).toMatchObject({
      status: 'cooling',
      providers: [],
      providerSince: null,
      consecutivePasses: 0,
      cooldownUntil: MANUAL_HOLD_UNTIL,
      excludedProviders: listedGlm.excludedProviders,
      businessDelistsAt: listedGlm.businessDelistsAt,
    });
    expect(event).toEqual({
      type: 'delisted',
      cause: null,
      reasons: ['运营手动下架'],
      cooldownUntil: MANUAL_HOLD_UNTIL,
    });
  });

  it('is not relisted by evaluation even when official data keeps passing', () => {
    let state = delistManually({ state: listedGlm }).state;
    for (let round = 0; round < 5; round += 1) {
      state = advanceState({
        state,
        now: new Date(NOW.getTime() + round * 30 * 60_000),
        screening: passing,
        business: { kind: 'insufficient', turns: 0 },
        relist: DEFAULT_FREE_ZONE_CONFIG.relist,
        priceBandRatio: 3,
      }).state;
    }
    expect(state.status).toBe('cooling');
  });

  it('comes back through list-now', () => {
    const held = delistManually({ state: listedGlm }).state;
    const { state } = listManually({ state: held, provider: 'zai', now: NOW, requiredPasses: 2 });
    expect(state).toMatchObject({ status: 'listed', providers: ['zai'], cooldownUntil: null });
  });
});

function deps(outcome: (current: FreeZoneModelState) => ManualDelistingOutcome): DelistNowDeps {
  const config = FreeZoneConfigSchema.parse({
    ...DEFAULT_FREE_ZONE_CONFIG,
    candidates: [
      {
        id: 'free-glm-5',
        surplus_model: 'glm-5',
        display_name: 'GLM 5',
        family: 'glm',
        benchmark_tier: 'standard',
      },
    ],
  });
  return {
    loadConfig: async () => config,
    save: async (input) => {
      const result = outcome(listedGlm);
      if (result.kind === 'saved') input.build(listedGlm);
      return result;
    },
  };
}

describe('delistFreeZoneModelNow', () => {
  it('delists a listed model and reports the provider it was on', async () => {
    const result = await delistFreeZoneModelNow(
      { candidateId: 'free-glm-5' },
      deps((current) => ({
        kind: 'saved',
        previous: current,
        state: delistManually({ state: current }).state,
      }))
    );
    expect(result).toEqual({
      candidate_id: 'free-glm-5',
      display_name: 'GLM 5',
      providers: ['zai'],
    });
  });

  it('also works for a listed row that is no longer in the pool', async () => {
    const result = await delistFreeZoneModelNow(
      { candidateId: 'free-gemini-2-5-flash' },
      deps((current) => ({
        kind: 'saved',
        previous: current,
        state: delistManually({ state: current }).state,
      }))
    );
    expect(result.display_name).toBe('free-gemini-2-5-flash');
  });

  it('refuses a model that is not listed', async () => {
    await expect(
      delistFreeZoneModelNow(
        { candidateId: 'free-glm-5' },
        deps(() => ({ kind: 'not_listed' }))
      )
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('不在架') });
  });
});
