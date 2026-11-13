import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG, FreeZoneConfigSchema } from '@miniapp/shared';
import { initialState, listManually, type FreeZoneModelState } from './lifecycle.js';
import { FreeZoneListNowError, listFreeZoneModelNow, type ListNowDeps } from './manual-list.js';
import type { ProbeFn } from './probe.js';
import type { ManualListingOutcome } from './repository.js';
import type { SurplusModelMarket } from './surplus-market.js';

const NOW = new Date('2026-11-12T08:30:00.000Z');

function market(provider: string, uptimePct = 98, ...others: string[]): SurplusModelMarket {
  return {
    book: {
      offers: [provider, ...others].flatMap((name) =>
        Array.from({ length: 5 }, () => ({
          provider: name,
          discountPct: 95,
          pricePer1m: 1000,
          available: true,
          healthy: true,
          trusted: true,
        }))
      ),
      realized7dDiscountPct: 90,
    },
    performance: [provider, ...others].map((name, index) => ({
      provider: name,
      requests: 1000,
      uptimePct,
      // 第一家最快：pickProvider 会先挑它
      ttftP50Ms: 1670 + index * 500,
      ttftP90Ms: 4108,
      tpsP50: 54,
      cacheHitRatePct: 80,
    })),
  };
}

const okProbe: ProbeFn = async ({ provider }) => ({
  provider,
  outcome: 'ok',
  first_token_ms: 900,
  detail: null,
});

/** 订单簿达标、按折扣底线派不出单（DeepSeek 官方渠道 11-12 的情况） */
const unroutableAt =
  (bad: string): ProbeFn =>
  async (input) =>
    input.provider === bad
      ? {
          provider: bad,
          outcome: 'unroutable',
          first_token_ms: null,
          detail: '404 minimum_discount_not_met',
        }
      : okProbe(input);

const coolingGlm: FreeZoneModelState = {
  ...initialState('free-glm-5'),
  status: 'cooling',
  cooldownUntil: '2026-11-13T07:52:39.254Z',
  excludedProviders: { zai: '2026-11-13T07:52:39.254Z', other: '2026-11-13T00:00:00.000Z' },
  businessDelistsAt: ['2026-11-12T07:52:39.254Z'],
  lastReason: '没出字率% 41 > 10',
};

describe('listManually', () => {
  it('lists right away on the given provider, clearing cooldown and that provider’s exclusion only', () => {
    const { state, event } = listManually({
      state: coolingGlm,
      provider: 'zai',
      now: NOW,
      requiredPasses: 2,
    });
    expect(state).toMatchObject({
      status: 'listed',
      providers: ['zai'],
      providerSince: NOW.toISOString(),
      cooldownUntil: null,
      consecutivePasses: 2,
      lastReason: null,
      excludedProviders: { other: '2026-11-13T00:00:00.000Z' },
      // 再因业务下架时冷却照样逐级拉长
      businessDelistsAt: coolingGlm.businessDelistsAt,
    });
    expect(event).toEqual({ type: 'listed', providers: ['zai'], manual: true });
  });
});

function deps(overrides: Partial<ListNowDeps> = {}): ListNowDeps & {
  saved: FreeZoneModelState[];
} {
  const saved: FreeZoneModelState[] = [];
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
    saved,
    loadConfig: async () => config,
    fetchMarket: async () => market('zai'),
    probe: okProbe,
    now: () => NOW,
    save: async (input): Promise<ManualListingOutcome> => {
      const next = input.build(coolingGlm);
      saved.push(next.state);
      return { kind: 'saved', previous: coolingGlm, state: next.state };
    },
    ...overrides,
  };
}

describe('listFreeZoneModelNow', () => {
  it('picks the provider from live screening when none is given', async () => {
    const d = deps();
    const result = await listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d);
    expect(result).toEqual({
      candidate_id: 'free-glm-5',
      display_name: 'GLM 5',
      provider: 'zai',
      provider_source: 'screening',
      previous_status: 'cooling',
    });
    expect(d.saved[0]?.status).toBe('listed');
  });

  it('uses the requested provider without asking the market', async () => {
    const fetchMarket = vi.fn(async () => market('zai'));
    const d = deps({ fetchMarket });
    const result = await listFreeZoneModelNow(
      { candidateId: 'free-glm-5', provider: 'deepinfra' },
      d
    );
    expect(result.provider).toBe('deepinfra');
    expect(result.provider_source).toBe('requested');
    expect(fetchMarket).not.toHaveBeenCalled();
    expect(d.saved[0]?.providers).toEqual(['deepinfra']);
  });

  it('refuses a requested provider that is on the blocked list', async () => {
    const base = deps();
    const config = await base.loadConfig();
    const probe = vi.fn(okProbe);
    const d = deps({
      probe,
      loadConfig: async () => ({
        ...config,
        screening: { ...config.screening, blocked_providers: ['dashscope-cn'] },
      }),
    });
    await expect(
      listFreeZoneModelNow({ candidateId: 'free-glm-5', provider: 'DashScope-CN' }, d)
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('屏蔽渠道') });
    expect(probe).not.toHaveBeenCalled();
    expect(d.saved).toHaveLength(0);
  });

  it('refuses when nothing passes screening and no provider was given', async () => {
    const d = deps({ fetchMarket: async () => market('zai', 50) });
    await expect(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(d.saved).toHaveLength(0);
  });

  it('reports an unreachable market as 502 instead of guessing', async () => {
    const d = deps({
      fetchMarket: async () => {
        throw new Error('timeout');
      },
    });
    await expect(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d)).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it('rejects candidates that are not in the published pool', async () => {
    await expect(listFreeZoneModelNow({ candidateId: 'free-nope' }, deps())).rejects.toBeInstanceOf(
      FreeZoneListNowError
    );
  });

  it('does not touch a model that is already listed', async () => {
    const d = deps({
      save: async () => ({ kind: 'already_listed', providers: ['zai'] }),
    });
    await expect(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('已经在架'),
    });
  });

  it('skips a provider the dispatch probe cannot route at the discount floor', async () => {
    const d = deps({
      fetchMarket: async () => market('deepseek', 98, 'dashscope-cn'),
      probe: unroutableAt('deepseek'),
    });
    const result = await listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d);
    expect(result.provider).toBe('dashscope-cn');
    expect(d.saved[0]?.providers).toEqual(['dashscope-cn']);
  });

  it('refuses when no screened provider can actually be dispatched', async () => {
    const d = deps({
      fetchMarket: async () => market('deepseek'),
      probe: unroutableAt('deepseek'),
    });
    await expect(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('派不出去'),
    });
    expect(d.saved).toHaveLength(0);
  });

  it('refuses a requested provider that cannot be dispatched', async () => {
    const d = deps({ probe: unroutableAt('deepseek') });
    await expect(
      listFreeZoneModelNow({ candidateId: 'free-glm-5', provider: 'deepseek' }, d)
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('派不出单') });
    expect(d.saved).toHaveLength(0);
  });

  it('does not list when the probe cannot tell (network trouble)', async () => {
    const d = deps({
      probe: async ({ provider }) => ({
        provider,
        outcome: 'error',
        first_token_ms: null,
        detail: 'timeout',
      }),
    });
    await expect(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d)).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(d.saved).toHaveLength(0);
  });
});
