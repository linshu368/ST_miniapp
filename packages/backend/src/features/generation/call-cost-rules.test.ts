import { describe, expect, it } from 'vitest';
import {
  estimatePromptCost,
  planPendingCall,
  promptPriceIndex,
  type PendingCall,
} from './call-cost-rules.js';

const now = Date.parse('2026-11-19T12:00:00Z');
const minutes = (value: number) => value * 60 * 1000;
const call = (overrides: Partial<PendingCall>): PendingCall => ({
  id: 'c1',
  provider: 'openrouter',
  endReason: 'cancelled',
  generationId: 'gen-1',
  dispatchedAt: now - minutes(30),
  attempts: 0,
  hasCost: false,
  ...overrides,
});

describe('planPendingCall for Surplus calls nobody writes a cost for', () => {
  const unowned = (overrides: Partial<PendingCall>) =>
    call({
      provider: 'surplus',
      representsAttempt: false,
      requestId: 'req-1',
      generationId: null,
      ...overrides,
    });

  it('looks the request record up after 20 minutes, without waiting 2 hours', () => {
    expect(planPendingCall(unowned({ dispatchedAt: now - minutes(10) }), now)).toBe('wait');
    expect(planPendingCall(unowned({ dispatchedAt: now - minutes(25) }), now)).toBe(
      'surplus_lookup'
    );
  });

  it('gives up without a request id, after 8 tries or after a day', () => {
    expect(planPendingCall(unowned({ requestId: null }), now)).toBe('unavailable');
    expect(planPendingCall(unowned({ attempts: 8 }), now)).toBe('unavailable');
    expect(planPendingCall(unowned({ dispatchedAt: now - minutes(25 * 60) }), now)).toBe(
      'unavailable'
    );
  });

  it('keeps the 2-hour wait for the row the Surplus record function writes', () => {
    expect(
      planPendingCall(
        call({ provider: 'surplus', representsAttempt: true, requestId: 'req-1' }),
        now
      )
    ).toBe('wait');
  });
});

describe('planPendingCall', () => {
  it('labels calls that already carry a cost', () => {
    expect(planPendingCall(call({ hasCost: true, provider: 'surplus' }), now)).toBe('known');
  });

  it('waits for the regular writers before deciding', () => {
    expect(planPendingCall(call({ dispatchedAt: now - minutes(5) }), now)).toBe('wait');
    // Surplus request records may still bring the response amount
    expect(
      planPendingCall(call({ provider: 'surplus', dispatchedAt: now - minutes(90) }), now)
    ).toBe('wait');
  });

  it('does not price Surplus or Venice calls without a returned amount', () => {
    expect(
      planPendingCall(call({ provider: 'surplus', dispatchedAt: now - minutes(130) }), now)
    ).toBe('unavailable');
    expect(planPendingCall(call({ provider: 'venice' }), now)).toBe('unavailable');
  });

  it('looks OpenRouter generations up, then estimates stopped calls and gives up on early failures', () => {
    expect(planPendingCall(call({}), now)).toBe('lookup');
    expect(planPendingCall(call({ attempts: 8 }), now)).toBe('estimate');
    expect(planPendingCall(call({ generationId: null }), now)).toBe('estimate');
    expect(
      planPendingCall(call({ generationId: null, endReason: 'first_token_deadline' }), now)
    ).toBe('estimate');
    expect(planPendingCall(call({ generationId: null, endReason: 'upstream_error' }), now)).toBe(
      'unavailable'
    );
    expect(planPendingCall(call({ dispatchedAt: now - minutes(60 * 25) }), now)).toBe('estimate');
  });

  it('closes anything older than the pending window', () => {
    expect(planPendingCall(call({ dispatchedAt: now - minutes(60 * 24 * 8) }), now)).toBe(
      'unavailable'
    );
  });
});

describe('promptPriceIndex', () => {
  it('prices by the requested model id and falls back to the dated canonical slug', () => {
    const index = promptPriceIndex([
      {
        id: 'deepseek/deepseek-v4.1-flash-1017',
        canonical_slug: 'deepseek/deepseek-v4.1-flash-20261017',
        prompt_usd_per_token: 0.00000015,
      },
      { id: 'z-ai/glm-5.2', canonical_slug: null, prompt_usd_per_token: 0.00000062 },
    ]);
    expect(index.get('deepseek/deepseek-v4.1-flash-1017')).toBe(0.00000015);
    expect(index.get('deepseek/deepseek-v4.1-flash-20261017')).toBe(0.00000015);
    expect(index.get('z-ai/glm-5.2')).toBe(0.00000062);
    expect(index.get('unknown/model')).toBeUndefined();
  });
});

describe('estimatePromptCost', () => {
  it('multiplies prompt tokens by the input price and refuses missing or junk inputs', () => {
    expect(estimatePromptCost(25963, 0.00000015)).toBe('0.003894450');
    expect(estimatePromptCost(null, 0.00000015)).toBeNull();
    expect(estimatePromptCost(0, 0.00000015)).toBeNull();
    expect(estimatePromptCost(1000, undefined)).toBeNull();
    expect(estimatePromptCost(1000, null)).toBeNull();
    expect(estimatePromptCost(Number.NaN, 0.00000015)).toBeNull();
    expect(estimatePromptCost(1000, -1)).toBeNull();
  });
});
