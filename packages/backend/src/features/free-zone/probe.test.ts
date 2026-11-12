import { describe, expect, it } from 'vitest';
import { DEFAULT_FREE_ZONE_CONFIG, type FreeZoneProbe } from '@miniapp/shared';
import { initialState, type FreeZoneModelState } from './lifecycle.js';
import { createSurplusProbe, type ProbeFn } from './probe.js';
import {
  clearSurplusReasoningRejections,
  surplusReasoningAccepted,
} from '../generation/surplus-reasoning.js';
import { applyProbes, probeCheck } from './probe-screening.js';
import { summarizeScreening, type ScreeningResult } from './screening.js';

const rules = DEFAULT_FREE_ZONE_CONFIG.screening;

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

describe('createSurplusProbe', () => {
  const run = (response: Response | (() => Promise<Response>)) =>
    createSurplusProbe({
      forward: (async () => (typeof response === 'function' ? response() : response)) as never,
    })({ model: 'm', provider: 'deepseek', minDiscountPct: 85 });

  it('treats a first content or reasoning delta as the first token', async () => {
    const result = await run(
      sse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"想"}}]}\n\n',
      ])
    );
    expect(result).toMatchObject({ provider: 'deepseek', outcome: 'ok', detail: null });
    expect(result.first_token_ms).toBeGreaterThanOrEqual(0);
  });

  it('marks discount-floor and no-seller rejections as unroutable', async () => {
    const reject = (status: number, code: string) =>
      new Response(JSON.stringify({ error: { code, message: 'nope' } }), { status });
    expect((await run(reject(404, 'minimum_discount_not_met'))).outcome).toBe('unroutable');
    expect((await run(reject(503, 'no_healthy_sellers'))).outcome).toBe('unroutable');
    expect((await run(reject(500, 'internal'))).outcome).toBe('error');
    expect((await run(reject(429, 'rate_limited'))).outcome).toBe('error');
  });

  it('retries without reasoning when the provider rejects the field, and remembers it', async () => {
    clearSurplusReasoningRejections();
    const bodies: string[] = [];
    const probe = createSurplusProbe({
      forward: (async (input: { body?: string }) => {
        bodies.push(String(input.body));
        return bodies.length === 1
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'request_rejected',
                  message: '{"detail":[{"type":"extra_forbidden","loc":["body","reasoning"]}]}',
                },
              }),
              { status: 400 }
            )
          : sse(['data: {"choices":[{"delta":{"content":"好"}}]}\n\n']);
      }) as never,
    });
    const result = await probe({ model: 'glm-5.2', provider: 'picky', minDiscountPct: 85 });
    expect(result.outcome).toBe('ok');
    expect(bodies[0]).toContain('"reasoning"');
    expect(bodies[1]).not.toContain('"reasoning"');
    expect(surplusReasoningAccepted('picky')).toBe(false);
  });

  it('treats a network failure or an empty stream as unknown', async () => {
    expect(
      (
        await run(async () => {
          throw new Error('socket hang up');
        })
      ).outcome
    ).toBe('error');
    expect((await run(sse(['data: [DONE]\n\n']))).outcome).toBe('error');
  });
});

const qualified = (provider: string, price: number, ttftP50Ms: number) => ({
  provider,
  price,
  ttftP50Ms,
  qualifiedOffers: 5,
});

const screening: ScreeningResult = {
  pass: true,
  qualified: [qualified('fast', 100, 916), qualified('slow', 120, 2254)],
  reasons: [],
  realized7dDiscountPct: 90,
  modelCheck: { key: 'min_realized_discount_pct', value: 90, threshold: null, pass: null },
  detail: [],
};

function scripted(outcomes: Record<string, FreeZoneProbe['outcome'] | number>): {
  probe: ProbeFn;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    probe: async ({ provider }) => {
      calls.push(provider);
      const outcome = outcomes[provider] ?? 'ok';
      return typeof outcome === 'number'
        ? { provider, outcome: 'ok', first_token_ms: outcome, detail: null }
        : { provider, outcome, first_token_ms: outcome === 'ok' ? 1200 : null, detail: '404' };
    },
  };
}

const now = new Date('2026-11-12T05:00:00Z');
const listedOn = (provider: string): FreeZoneModelState => ({
  ...initialState('free-a'),
  status: 'listed',
  providers: [provider],
  providerSince: '2026-11-12T04:00:00Z',
});

describe('applyProbes', () => {
  const apply = (state: FreeZoneModelState, probe: ProbeFn, extra = {}) =>
    applyProbes({ model: 'm', screening, state, now, rules: { ...rules, ...extra }, probe });

  it('probes only the provider that would be used and keeps the screening when it routes', async () => {
    const { probe, calls } = scripted({});
    const result = await apply(initialState('free-a'), probe);
    expect(calls).toEqual(['fast']);
    expect(result).toMatchObject({ hold: false, chosen: { provider: 'fast', outcome: 'ok' } });
    expect(result.screening?.qualified.map((item) => item.provider)).toEqual(['fast', 'slow']);
  });

  it('drops an unroutable provider and falls through to the next', async () => {
    const { probe, calls } = scripted({ fast: 'unroutable' });
    const result = await apply(listedOn('fast'), probe);
    expect(calls).toEqual(['fast', 'slow']);
    expect(result.screening?.qualified.map((item) => item.provider)).toEqual(['slow']);
    expect(result.screening?.pass).toBe(true);
    expect(result.chosen?.provider).toBe('slow');
  });

  it('fails the round when no provider routes', async () => {
    const { probe } = scripted({ fast: 'unroutable', slow: 'unroutable' });
    const result = await apply(initialState('free-a'), probe);
    expect(result.screening).toMatchObject({ pass: false, qualified: [] });
    expect(result.screening?.reasons.join()).toContain('探测派不出去');
    expect(probeCheck(result.probes, rules)).toEqual({ threshold: 85, passed: 0, total: 2 });
    const summary = summarizeScreening(result.screening!, probeCheck(result.probes, rules));
    expect(summary.checks.at(-1)).toEqual({ key: 'probe', threshold: 85, passed: 0, total: 2 });
  });

  it('holds the whole round when a probe cannot tell', async () => {
    const { probe } = scripted({ fast: 'error' });
    expect((await apply(listedOn('fast'), probe)).hold).toBe(true);
  });

  it('applies the optional probe first-token line', async () => {
    const { probe } = scripted({ fast: 15_000, slow: 3_000 });
    const result = await apply(initialState('free-a'), probe, { max_probe_ttft_ms: 7_500 });
    expect(result.chosen).toMatchObject({ provider: 'slow', first_token_ms: 3_000 });
    expect(result.screening?.reasons.join()).toContain('探测首字 15000 > 7500');
  });

  it('skips probing when disabled, when screening failed, or while cooling', async () => {
    const { probe, calls } = scripted({});
    await apply(initialState('free-a'), probe, { probe_enabled: false });
    await applyProbes({
      model: 'm',
      screening: { ...screening, pass: false },
      state: initialState('free-a'),
      now,
      rules,
      probe,
    });
    await apply(
      { ...initialState('free-a'), status: 'cooling', cooldownUntil: '2026-11-12T06:00:00Z' },
      probe
    );
    expect(calls).toEqual([]);
  });
});
