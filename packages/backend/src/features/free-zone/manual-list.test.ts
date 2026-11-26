import { describe, expect, it, vi } from 'vitest';
import { FreeZoneConfigSchema } from '@miniapp/shared';
import { initialState, listManually, type FreeZoneModelState } from './lifecycle.js';
import {
  FreeZoneListNowError,
  listFreeZoneModelNow,
  rankProviders,
  type ListNowDeps,
} from './manual-list.js';
import { parseMarketBook, type MarketBook, type MarketOffer } from './surplus-market.js';

const NOW = new Date('2026-11-24T08:30:00.000Z');
const DIRECT = { inputPer1m: 500_000, outputPer1m: 3_000_000, source: 'OpenRouter' };

function offer(provider: string, discountPct: number | null, patch: Partial<MarketOffer> = {}) {
  return { provider, discountPct, available: true, healthy: true, trusted: true, ...patch };
}

function book(...offers: MarketOffer[]): MarketBook {
  return { offers, directPrice: DIRECT };
}

const unlisted: FreeZoneModelState = {
  ...initialState('free-glm-5'),
  lastReason: '运营手动下架',
};

function deps(
  options: { market?: MarketBook | Error; floor?: number | null; listed?: boolean } = {}
) {
  const config = FreeZoneConfigSchema.parse({
    screening: { min_discount_pct: 90, blocked_providers: ['DashScope-CN'] },
    candidates: [
      {
        id: 'free-glm-5',
        surplus_model: 'glm-5',
        display_name: 'GLM 5',
        family: 'glm',
        benchmark_tier: 'standard',
        min_discount_pct: options.floor ?? null,
      },
    ],
  });
  const fetchBook = vi.fn(async (_model: string) => {
    const market = options.market ?? book(offer('zai', 95));
    if (market instanceof Error) throw market;
    return market;
  });
  const save = vi.fn<ListNowDeps['save']>(async (input) =>
    options.listed
      ? { kind: 'already_listed', providers: ['zai'] }
      : { kind: 'saved', previous: unlisted, state: input.build(unlisted).state }
  );
  return { loadConfig: async () => config, fetchBook, save, now: () => NOW };
}

async function failure(promise: Promise<unknown>): Promise<FreeZoneListNowError> {
  const error = await promise.catch((err: unknown) => err);
  if (!(error instanceof FreeZoneListNowError)) throw new Error('expected a FreeZoneListNowError');
  return error;
}

describe('listManually', () => {
  it('lists right away on the given provider', () => {
    const { state, event } = listManually({ state: unlisted, provider: 'zai', now: NOW });
    expect(state).toEqual({
      candidateId: 'free-glm-5',
      status: 'listed',
      providers: ['zai'],
      providerSince: NOW.toISOString(),
      lastReason: null,
      pinned: false,
    });
    expect(event).toEqual({ type: 'listed', providers: ['zai'] });
  });
});

describe('rankProviders', () => {
  it('ranks trusted, usable, unblocked providers by their best discount', () => {
    const market = book(
      offer('zai', 80),
      offer('zai', 95),
      offer('venice', 97),
      offer('inferhub', 99, { trusted: false }),
      offer('bankr', 99, { available: false }),
      offer('engy', 99, { healthy: false }),
      offer('mordiem', null),
      offer('dashscope-cn', 99)
    );
    expect(rankProviders(market, ['DashScope-CN'])).toEqual([
      { provider: 'venice', discountPct: 97 },
      { provider: 'zai', discountPct: 95 },
    ]);
  });
});

describe('listFreeZoneModelNow', () => {
  it('picks the deepest discount at or above the floor and keeps the list price', async () => {
    const d = deps({ market: book(offer('venice', 92), offer('zai', 95), offer('zai', 60)) });
    expect(await listFreeZoneModelNow({ candidateId: 'free-glm-5' }, d)).toEqual({
      candidate_id: 'free-glm-5',
      display_name: 'GLM 5',
      provider: 'zai',
      provider_source: 'market',
    });
    expect(d.fetchBook).toHaveBeenCalledWith('glm-5');
    expect(d.save.mock.calls[0]?.[0]).toMatchObject({
      candidateId: 'free-glm-5',
      surplusModel: 'glm-5',
      directPrice: DIRECT,
    });
  });

  it('uses the requested provider without asking the market', async () => {
    const d = deps();
    const result = await listFreeZoneModelNow({ candidateId: 'free-glm-5', provider: 'venice' }, d);
    expect(result).toMatchObject({ provider: 'venice', provider_source: 'requested' });
    expect(d.fetchBook).not.toHaveBeenCalled();
    expect(d.save.mock.calls[0]?.[0].directPrice).toBeNull();
  });

  it('uses the model’s own floor and says how far the best offer is when nothing reaches it', async () => {
    const market = book(offer('zai', 75));
    const shallow = deps({ market });
    const error = await failure(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, shallow));
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('没有供应商达到 90% 折扣底线（最好的是 zai 75%）');
    expect(shallow.save).not.toHaveBeenCalled();
    const own = deps({ market, floor: 70 });
    expect(await listFreeZoneModelNow({ candidateId: 'free-glm-5' }, own)).toMatchObject({
      provider: 'zai',
    });
  });

  it('refuses blocked providers, whether requested or the only ones on offer', async () => {
    const requested = deps();
    const asked = await failure(
      listFreeZoneModelNow({ candidateId: 'free-glm-5', provider: 'dashscope-cn' }, requested)
    );
    expect(asked.statusCode).toBe(409);
    const only = deps({ market: book(offer('dashscope-cn', 99)) });
    const none = await failure(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, only));
    expect(none.message).toBe('现在没有可用的 trusted 供应商');
  });

  it('reports an unknown candidate, a market failure and an already listed model', async () => {
    const unknown = await failure(listFreeZoneModelNow({ candidateId: 'free-nope' }, deps()));
    expect(unknown.statusCode).toBe(404);
    const down = deps({ market: new Error('boom') });
    const market = await failure(listFreeZoneModelNow({ candidateId: 'free-glm-5' }, down));
    expect(market.statusCode).toBe(502);
    expect(down.save).not.toHaveBeenCalled();
    const again = await failure(
      listFreeZoneModelNow({ candidateId: 'free-glm-5' }, deps({ listed: true }))
    );
    expect(again.statusCode).toBe(409);
    expect(again.message).toContain('已经在架（供应商 zai）');
  });
});

describe('parseMarketBook', () => {
  it('keeps unknown fields as null and drops offers without a provider', () => {
    expect(
      parseMarketBook({
        offers: [{ provider_id: 'zai', discount_pct: 'x', available: true }, { discount_pct: 99 }],
        direct_price: { input_per_1m: 500_000, reference_source: 'OpenRouter' },
      })
    ).toEqual({
      offers: [
        { provider: 'zai', discountPct: null, available: true, healthy: false, trusted: false },
      ],
      directPrice: { inputPer1m: 500_000, outputPer1m: null, source: 'OpenRouter' },
    });
    expect(parseMarketBook(null)).toEqual({ offers: [], directPrice: null });
  });
});
