import { describe, expect, it } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG, FreeZoneConfigSchema } from '@miniapp/shared';
import {
  pickProvider,
  screenModel,
  summarizeScreening,
  type QualifiedProvider,
} from './screening.js';
import {
  advanceState,
  initialState,
  judgeBusinessMetrics,
  type BusinessVerdict,
  type FreeZoneModelState,
} from './lifecycle.js';
import { chooseReplacement, resolveFreeZoneView } from './zone-view.js';
import type { SurplusModelMarket } from './surplus-market.js';

const rules = DEFAULT_FREE_ZONE_CONFIG.screening;
const relist = DEFAULT_FREE_ZONE_CONFIG.relist;
const ratio = rules.price_band_ratio;

function offer(provider: string, discountPct: number, price = 1000, trusted = true) {
  return { provider, discountPct, pricePer1m: price, available: true, healthy: true, trusted };
}

function perf(provider: string, overrides: Record<string, number | null> = {}) {
  return {
    provider,
    requests: 1000,
    uptimePct: 98,
    ttftP50Ms: 1670,
    ttftP90Ms: 4108,
    tpsP50: 54,
    cacheHitRatePct: 80,
    ...overrides,
  };
}

function market(
  offers: ReturnType<typeof offer>[],
  performance = [perf('deepseek')]
): SurplusModelMarket {
  return { book: { offers, realized7dDiscountPct: 90 }, performance };
}

const fiveDeep = (provider: string, price = 1000) =>
  Array.from({ length: 5 }, () => offer(provider, 95, price));

function qualified(provider: string, price: number | null, ttftP50Ms: number): QualifiedProvider {
  return { provider, price, ttftP50Ms, qualifiedOffers: 5 };
}

describe('screenModel', () => {
  it('qualifies a trusted provider with enough deep offers and good performance', () => {
    const result = screenModel(market(fiveDeep('deepseek', 900)), rules);
    expect(result.pass).toBe(true);
    expect(result.qualified).toEqual([qualified('deepseek', 900, 1670)]);
  });

  it('ignores untrusted offers entirely', () => {
    const offers = Array.from({ length: 9 }, () => offer('inferhub', 99, 10, false));
    const result = screenModel(market(offers, [perf('inferhub')]), rules);
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain('没有 trusted 供应商');
  });

  it('drops blocked providers (case-insensitive) and falls back to the remaining ones', () => {
    const offers = [...fiveDeep('dashscope-cn', 500), ...fiveDeep('deepseek', 900)];
    const performance = [perf('dashscope-cn', { ttftP50Ms: 1000 }), perf('deepseek')];
    const blocked = { ...rules, blocked_providers: ['DashScope-CN'] };
    const result = screenModel(market(offers, performance), blocked);
    expect(result.qualified).toEqual([qualified('deepseek', 900, 1670)]);
    expect(result.detail.map((row) => row.provider)).toEqual(['deepseek']);
  });

  it('says so when every trusted provider is blocked', () => {
    const result = screenModel(market(fiveDeep('dashscope-cn'), [perf('dashscope-cn')]), {
      ...rules,
      blocked_providers: ['dashscope-cn'],
    });
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual(['只有屏蔽渠道：dashscope-cn']);
  });

  it('treats unknown metrics as failing when the threshold is set, skips null thresholds', () => {
    const unknownUptime = market(fiveDeep('deepseek'), [perf('deepseek', { uptimePct: null })]);
    expect(screenModel(unknownUptime, rules).reasons.join()).toContain('成功率未知');
    expect(screenModel(unknownUptime, { ...rules, min_uptime_pct: null }).pass).toBe(true);
  });

  it('only counts offers at or above the discount floor and prices by the cheapest of them', () => {
    const offers = [...fiveDeep('deepseek', 800), offer('deepseek', 80, 100)];
    expect(screenModel(market(offers), rules).qualified[0]?.price).toBe(800);
    const shallow = [
      ...Array.from({ length: 4 }, () => offer('deepseek', 95)),
      offer('deepseek', 80),
    ];
    expect(screenModel(market(shallow), rules).pass).toBe(false);
  });

  it('rejects a provider below the cache hit line, and skips the check when cleared', () => {
    const lowCache = market(fiveDeep('google'), [perf('google', { cacheHitRatePct: 9.5 })]);
    const result = screenModel(lowCache, rules);
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toContain('缓存命中率 9.5 < 70');
    expect(screenModel(lowCache, { ...rules, min_cache_hit_rate_pct: null }).pass).toBe(true);
  });
});

describe('summarizeScreening', () => {
  it('counts how many providers pass each check and names the closest one', () => {
    const result = screenModel(
      market(
        [...fiveDeep('fast'), offer('slow', 95)],
        [perf('fast', { ttftP50Ms: 4108 }), perf('slow', { uptimePct: 80 })]
      ),
      rules
    );
    const summary = summarizeScreening(result);
    expect(summary.pass).toBe(false);
    const byKey = Object.fromEntries(summary.checks.map((item) => [item.key, item]));
    expect(byKey.min_qualified_offers).toMatchObject({ passed: 1, total: 2, threshold: 5 });
    expect(byKey.max_ttft_p50_ms).toMatchObject({ passed: 1, total: 2 });
    expect(byKey.min_uptime_pct).toMatchObject({ passed: 1, total: 2 });
    expect(byKey.min_realized_discount_pct).toMatchObject({ passed: 1, total: 1 });
    expect(summary.closest).toEqual({ provider: 'fast', failed: ['max_ttft_p50_ms'] });
  });
});

describe('pickProvider', () => {
  it('within the same price band (under 3x) picks the fastest first token', () => {
    const pool = [qualified('a', 100, 3043), qualified('b', 250, 1670), qualified('c', 120, 2254)];
    expect(pickProvider(pool, { ratio })).toBe('b');
  });

  it('keeps a 3x-or-more cheaper provider in its own band and prefers it', () => {
    const pool = [qualified('cheap', 100, 4108), qualified('pricey', 400, 916)];
    expect(pickProvider(pool, { ratio })).toBe('cheap');
  });

  it('sticks with the current provider while it still qualifies', () => {
    const pool = [qualified('a', 100, 3043), qualified('b', 100, 916)];
    expect(pickProvider(pool, { current: 'a', ratio })).toBe('a');
  });

  it('skips excluded providers and returns null when none remain', () => {
    const pool = [qualified('a', 100, 916), qualified('b', 150, 1670)];
    expect(pickProvider(pool, { excluded: new Set(['a']), ratio })).toBe('b');
    expect(pickProvider(pool, { excluded: new Set(['a', 'b']), ratio })).toBeNull();
  });
});

describe('advanceState', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const pass: BusinessVerdict = { kind: 'pass' };
  const fail: BusinessVerdict = { kind: 'fail', reasons: ['兜底交付率% 30 > 15'] };
  const twoProviders = screenModel(
    market(
      [...fiveDeep('fast', 100), ...fiveDeep('slow', 120)],
      [perf('fast', { ttftP50Ms: 916 }), perf('slow', { ttftP50Ms: 2254 })]
    ),
    rules
  );
  const onlySlow = screenModel(
    market(fiveDeep('slow', 120), [perf('slow', { ttftP50Ms: 2254 })]),
    rules
  );
  const nothing = screenModel(market([]), rules);
  const step = (
    state: FreeZoneModelState,
    screening: typeof twoProviders | null = twoProviders,
    business: BusinessVerdict = pass,
    at = now
  ) => advanceState({ state, now: at, screening, business, relist, priceBandRatio: ratio });
  const listedOn = (provider: string): FreeZoneModelState => ({
    ...initialState('free-a'),
    status: 'listed',
    providers: [provider],
    providerSince: '2026-11-12T00:00:00.000Z',
  });

  it('lists only after the required consecutive passes, on the picked provider', () => {
    const first = step(initialState('free-a'));
    expect(first.state.status).toBe('unlisted');
    const second = step(first.state);
    expect(second.state).toMatchObject({ status: 'listed', providers: ['fast'] });
    expect(second.state.providerSince).toBe(now.toISOString());
    expect(second.events).toEqual([{ type: 'listed', providers: ['fast'] }]);
  });

  it('a failed screening resets the streak', () => {
    const first = step(initialState('free-a'));
    expect(step(first.state, nothing).state.consecutivePasses).toBe(0);
  });

  it('holds a listed model when official data is missing', () => {
    const result = step(listedOn('slow'), null);
    expect(result.state.providers).toEqual(['slow']);
    expect(result.events).toEqual([]);
  });

  it('does not move off a still-qualified provider even if a faster one appears', () => {
    const result = step(listedOn('slow'));
    expect(result.state.providers).toEqual(['slow']);
    expect(result.events).toEqual([]);
  });

  it('falls through to the next provider when the current one stops qualifying', () => {
    const result = step(listedOn('gone'), onlySlow);
    expect(result.state).toMatchObject({ status: 'listed', providers: ['slow'] });
    expect(result.events[0]).toMatchObject({
      type: 'provider_switched',
      from: 'gone',
      to: 'slow',
      cause: 'official',
    });
  });

  it('delists with the short cooldown only when no provider qualifies', () => {
    const result = step(listedOn('fast'), nothing);
    expect(result.state.status).toBe('cooling');
    expect(result.state.cooldownUntil).toBe('2026-11-12T14:00:00.000Z');
  });

  it('on business failure excludes the provider and switches, then delists with escalation', () => {
    const switched = step(listedOn('fast'), twoProviders, fail);
    expect(switched.state.providers).toEqual(['slow']);
    expect(switched.state.excludedProviders.fast).toBe('2026-11-13T12:00:00.000Z');
    expect(switched.events[0]).toMatchObject({ type: 'provider_switched', cause: 'business' });

    const delisted = step(switched.state, twoProviders, fail);
    expect(delisted.state.status).toBe('cooling');
    expect(delisted.state.cooldownUntil).toBe('2026-11-13T12:00:00.000Z');

    const relistedLater = { ...delisted.state, status: 'listed' as const, providers: ['other'] };
    const again = step(relistedLater, nothing, fail, new Date('2026-11-14T12:00:00Z'));
    expect(again.state.cooldownUntil).toBe('2026-11-17T12:00:00.000Z');
  });

  it('returns to unlisted after cooldown and counts that tick as a pass', () => {
    const cooling: FreeZoneModelState = {
      ...initialState('free-a'),
      status: 'cooling',
      cooldownUntil: '2026-11-12T11:00:00Z',
    };
    const result = step(cooling);
    expect(result.state.status).toBe('unlisted');
    expect(result.state.consecutivePasses).toBe(1);
    expect(result.events[0]).toEqual({ type: 'cooldown_ended' });
  });
});

describe('judgeBusinessMetrics', () => {
  const onShelf = DEFAULT_FREE_ZONE_CONFIG.on_shelf;
  const base = {
    turns: 100,
    noOutputPct: 1,
    fallbackDeliveredPct: 5,
    timeoutPct: 0.5,
    ttftP90Ms: 4000,
    refusalPct: null,
    truncationPct: null,
    interruptedPct: 4,
    dislikePct: null,
  };

  it('does not judge with too few turns', () => {
    expect(judgeBusinessMetrics({ ...base, turns: 10 }, onShelf).kind).toBe('insufficient');
  });

  it('fails when any configured line is crossed', () => {
    const verdict = judgeBusinessMetrics({ ...base, noOutputPct: 12 }, onShelf);
    expect(verdict).toEqual({ kind: 'fail', reasons: ['没出字率% 12 > 10'] });
  });

  it('judges the mid-generation interruption rate once a line is set', () => {
    expect(judgeBusinessMetrics({ ...base, interruptedPct: 30.4 }, onShelf).kind).toBe('pass');
    const verdict = judgeBusinessMetrics(
      { ...base, interruptedPct: 30.4 },
      { ...onShelf, max_interrupted_pct: 5 }
    );
    expect(verdict).toEqual({ kind: 'fail', reasons: ['生成中断率% 30.4 > 5'] });
  });
});

describe('resolveFreeZoneView', () => {
  const pricing = { freeQuotaExhausted: 15, light: 15, standard: 33, premium: 55 };
  const candidate = {
    id: 'free-glm',
    surplus_model: 'glm-5.2',
    display_name: 'GLM 5.2',
    tagline: '中文专精',
    family: 'glm',
    benchmark_tier: 'premium' as const,
    parallel_requests: 1,
    min_discount_pct: null,
  };
  const config = FreeZoneConfigSchema.parse({
    enabled: true,
    rules_text: '规则',
    period: { starts_at: '2026-11-12T00:00:00+08:00', ends_at: '2026-11-30T00:00:00+08:00' },
    scope: 'own_cards',
    candidates: [candidate],
  });
  const listed = [{ candidate, providers: ['zai'] }];
  const at = (iso: string) => new Date(iso);
  const view = (overrides: Partial<Parameters<typeof resolveFreeZoneView>[0]> = {}) =>
    resolveFreeZoneView({
      config,
      listed,
      now: at('2026-11-20T00:00:00Z'),
      isOwnCard: true,
      pricing,
      ...overrides,
    });

  it('is hidden when disabled or after the period', () => {
    expect(view({ config: { ...config, enabled: false } })).toBeNull();
    expect(view({ now: at('2026-12-01T00:00:00Z') })).toBeNull();
  });

  it('reports not_started, no_models, own_card_only and open in that priority', () => {
    expect(view({ now: at('2026-11-10T00:00:00Z') })?.state).toBe('not_started');
    expect(view({ listed: [] })?.state).toBe('no_models');
    expect(view({ isOwnCard: false })?.state).toBe('own_card_only');
    const open = view();
    expect(open).toMatchObject({ state: 'open', ends_at: config.period?.ends_at });
    expect(open?.models[0]?.original_credits).toBe(55);
  });
});

describe('chooseReplacement', () => {
  const make = (id: string, family: string) => ({
    candidate: {
      id,
      surplus_model: id,
      display_name: id,
      tagline: 't',
      family,
      benchmark_tier: 'light' as const,
      parallel_requests: 1,
      min_discount_pct: null,
    },
    providers: ['p'],
  });

  it('prefers the same family, then any listed model, then nothing', () => {
    const usable = [make('free-gemini', 'gemini'), make('free-ds', 'deepseek')];
    const pick = (currentFamily: string, list = usable, roll = 0) =>
      chooseReplacement({ currentFamily, usable: list, random: () => roll })?.id ?? null;
    expect(pick('DeepSeek')).toBe('free-ds');
    expect(pick('glm', usable, 0.99)).toBe('free-ds');
    expect(pick('glm', [])).toBeNull();
  });
});
