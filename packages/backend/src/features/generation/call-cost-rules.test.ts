import { describe, expect, it } from 'vitest';
import { pickEstimate, planPendingCall, type PendingCall } from './call-cost-rules.js';

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

describe('pickEstimate', () => {
  it('prefers stopped samples, falls back to all fallbacks, and refuses junk', () => {
    expect(pickEstimate({ stoppedAvg: '0.0012', stoppedSamples: 5, fallbackAvg: '0.01' })).toBe(
      '0.001200000'
    );
    expect(pickEstimate({ stoppedAvg: '0.0012', stoppedSamples: 4, fallbackAvg: '0.01' })).toBe(
      '0.010000000'
    );
    expect(pickEstimate({ stoppedAvg: null, stoppedSamples: 0, fallbackAvg: null })).toBeNull();
    expect(pickEstimate({ stoppedAvg: 'NaN', stoppedSamples: 9, fallbackAvg: null })).toBeNull();
  });
});
