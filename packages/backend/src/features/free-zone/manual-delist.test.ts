import { describe, expect, it } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG, FreeZoneConfigSchema } from '@miniapp/shared';
import {
  delistManually,
  initialState,
  listManually,
  type FreeZoneModelState,
} from './lifecycle.js';
import { delistFreeZoneModelNow, type DelistNowDeps } from './manual-delist.js';
import type { DelistingOutcome } from './repository.js';

const NOW = new Date('2026-11-24T08:00:00.000Z');

const listedGlm: FreeZoneModelState = {
  ...initialState('free-glm-5'),
  status: 'listed',
  providers: ['zai'],
  providerSince: '2026-11-12T08:39:13.031Z',
};

describe('delistManually', () => {
  it('takes the model off now, and only a manual listing brings it back', () => {
    const { state, event } = delistManually({ state: listedGlm });
    expect(state).toEqual({
      candidateId: 'free-glm-5',
      status: 'unlisted',
      providers: [],
      providerSince: null,
      lastReason: '运营手动下架',
    });
    expect(event).toEqual({ type: 'delisted', cause: null, reasons: ['运营手动下架'] });
    expect(listManually({ state, provider: 'zai', now: NOW }).state).toMatchObject({
      status: 'listed',
      providers: ['zai'],
      lastReason: null,
    });
  });
});

function deps(outcome: (current: FreeZoneModelState) => DelistingOutcome): DelistNowDeps {
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
