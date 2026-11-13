import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG, FreeZoneConfigSchema } from '@miniapp/shared';
import { clearScreeningPreviewCache, previewFreeZoneScreening } from './admin-preview.js';
import { buildFreeZoneStatus } from './admin-status.js';
import type { SurplusModelMarket } from './surplus-market.js';

const rules = DEFAULT_FREE_ZONE_CONFIG.screening;

function market(
  provider: string,
  perf: { uptimePct?: number; ttftP50Ms?: number },
  realized = 90
): SurplusModelMarket {
  return {
    book: {
      offers: Array.from({ length: 5 }, () => ({
        provider,
        discountPct: 95,
        pricePer1m: 1000,
        available: true,
        healthy: true,
        trusted: true,
      })),
      realized7dDiscountPct: realized,
    },
    performance: [
      {
        provider,
        requests: 1000,
        uptimePct: perf.uptimePct ?? 98,
        ttftP50Ms: perf.ttftP50Ms ?? 1670,
        ttftP90Ms: 4108,
        tpsP50: 54,
        cacheHitRatePct: 80,
      },
    ],
  };
}

const markets: Record<string, SurplusModelMarket> = {
  good: market('deepseek', {}),
  slow: market('google', { ttftP50Ms: 3043 }),
  flaky: market('zai', { uptimePct: 92.7, ttftP50Ms: 3043 }),
  cheap7d: market('xai', {}, 58.8),
};

const candidates = ['good', 'slow', 'flaky', 'cheap7d', 'broken'].map((name) => ({
  id: `free-${name}`,
  surplus_model: name,
  display_name: name.toUpperCase(),
}));

describe('previewFreeZoneScreening', () => {
  beforeEach(() => clearScreeningPreviewCache());

  it('screens every candidate with the given thresholds and reports per-check results', async () => {
    const result = await previewFreeZoneScreening(
      { candidates, screening: rules },
      {
        fetchMarket: async (model) => {
          const found = markets[model];
          if (!found) throw new Error('timeout');
          return found;
        },
        now: () => Date.parse('2026-11-12T03:00:00Z'),
      }
    );
    const byId = Object.fromEntries(result.models.map((model) => [model.candidate_id, model]));
    expect(byId['free-good']).toMatchObject({ pass: true, picked_provider: 'deepseek' });
    expect(byId['free-broken']?.error).toContain('timeout');
    const slowP50 = byId['free-slow']?.providers[0]?.checks.find(
      (item) => item.key === 'max_ttft_p50_ms'
    );
    expect(slowP50).toEqual({ key: 'max_ttft_p50_ms', value: 3043, threshold: 3000, pass: false });
    expect(byId['free-cheap7d']?.model_checks[0]).toMatchObject({ value: 58.8, pass: false });

    const impact = Object.fromEntries(result.impact.map((item) => [item.key, item.unlocks]));
    // 只放开首字 p50 能救回 slow；flaky 同时卡成功率，单放一项救不回来。
    expect(impact.max_ttft_p50_ms).toEqual(['free-slow']);
    expect(impact.min_uptime_pct).toEqual([]);
    expect(impact.min_realized_discount_pct).toEqual(['free-cheap7d']);
    expect(result.checked_at).toBe('2026-11-12T03:00:00.000Z');
  });

  it('reuses market data for a minute so tweaking a threshold is instant', async () => {
    let calls = 0;
    let clock = 0;
    const deps = {
      fetchMarket: async () => {
        calls += 1;
        return markets.good!;
      },
      now: () => clock,
    };
    const input = { candidates: [candidates[0]!], screening: rules };
    await previewFreeZoneScreening(input, deps);
    clock = 59_000;
    await previewFreeZoneScreening({ ...input, screening: { ...rules, min_tps: 60 } }, deps);
    expect(calls).toBe(1);
    clock = 61_000;
    await previewFreeZoneScreening(input, deps);
    expect(calls).toBe(2);
  });
});

describe('buildFreeZoneStatus', () => {
  it('orders by the published pool and keeps removed candidates at the end', () => {
    const config = FreeZoneConfigSchema.parse({
      relist: { required_passes: 3 },
      candidates: [
        {
          id: 'free-a',
          surplus_model: 'a',
          display_name: 'A',
          family: 'x',
          benchmark_tier: 'light',
        },
        {
          id: 'free-b',
          surplus_model: 'b',
          display_name: 'B',
          family: 'x',
          benchmark_tier: 'light',
        },
      ],
    });
    const at = new Date('2026-11-12T02:30:00Z');
    const row = (candidate_id: string, status: 'listed' | 'unlisted') => ({
      candidate_id,
      surplus_model: candidate_id.replace('free-', ''),
      status,
      providers: status === 'listed' ? ['deepseek'] : [],
      provider_since: status === 'listed' ? at : null,
      excluded_providers: {},
      consecutive_passes: 1,
      cooldown_until: null,
      last_reason: null,
      last_metrics:
        candidate_id === 'free-b'
          ? {
              screening: {
                pass: false,
                summary: {
                  checks: [{ key: 'min_tps', threshold: 30, passed: 0, total: 2 }],
                  closest: { provider: 'zai', failed: ['min_tps'] },
                },
              },
              business: 'insufficient',
              turns: 46,
              fallback_delivered_pct: 39.7,
              no_output_pct: 41,
              primary_delivered_turns: 28,
              interrupted_turns: 7,
              interrupted_pct: 25,
              ttft_p90_ms: 9100,
            }
          : { screening: { pass: true }, turns: 12, fallback_delivered_pct: 0 },
      evaluated_at: at,
    });
    const status = buildFreeZoneStatus(
      config,
      [row('free-gone', 'unlisted'), row('free-b', 'listed')],
      [],
      [
        {
          candidate_id: 'free-a',
          ever_listed: true,
          last_delist_cause: 'business',
          last_delist_reason: '兜底交付率% 30 > 15',
          last_delisted_at: at,
        },
      ]
    );
    expect(status.models[0]).toMatchObject({
      ever_listed: true,
      last_delist: { cause: 'business', at: at.toISOString(), reason: '兜底交付率% 30 > 15' },
    });
    expect(status.models[1]).toMatchObject({ ever_listed: false, last_delist: null });
    expect(status.required_passes).toBe(3);
    expect(status.last_evaluated_at).toBe(at.toISOString());
    expect(
      status.models.map((model) => [model.candidate_id, model.status, model.in_config])
    ).toEqual([
      ['free-a', null, true],
      ['free-b', 'listed', true],
      ['free-gone', 'unlisted', false],
    ]);
    expect(status.models[1]?.screening).toEqual({
      pass: false,
      checks: [{ key: 'min_tps', threshold: 30, passed: 0, total: 2 }],
      closest: { provider: 'zai', failed: ['min_tps'] },
    });
    expect(status.models[2]?.screening).toBeNull();
    // 业务数据只给在架模型看；不在架的即使 last_metrics 里有旧数也不显示
    expect(status.models[1]?.business).toEqual({
      turns: 46,
      fallback_delivered_pct: 39.7,
      no_output_pct: 41,
      primary_delivered_turns: 28,
      interrupted_turns: 7,
      interrupted_pct: 25,
      ttft_p90_ms: 9100,
    });
    expect(status.models[2]?.business).toBeNull();
    // 介绍语可以不填
    expect(config.candidates[0]?.tagline).toBe('');
  });
});

describe('parameterImpact for qualified offers', () => {
  it('relaxes offers to one, never to zero', async () => {
    clearScreeningPreviewCache();
    const thin = market('deepseek', {});
    thin.book.offers = thin.book.offers.slice(0, 2);
    const none = market('google', {});
    none.book.offers = none.book.offers.map((offer) => ({ ...offer, discountPct: 50 }));
    const result = await previewFreeZoneScreening(
      {
        candidates: [
          { id: 'free-thin', surplus_model: 'thin', display_name: 'Thin' },
          { id: 'free-none', surplus_model: 'none', display_name: 'None' },
        ],
        screening: rules,
      },
      { fetchMarket: async (model) => (model === 'thin' ? thin : none) }
    );
    const offers = result.impact.find((item) => item.key === 'min_qualified_offers');
    expect(offers?.unlocks).toEqual(['free-thin']);
  });
});
