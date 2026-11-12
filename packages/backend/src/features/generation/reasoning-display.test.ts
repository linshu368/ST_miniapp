import { describe, expect, it } from 'vitest';
import { revealsReasoning, shouldRevealReasoning } from './reasoning-display.js';
import type { ResolvedModel } from './types.js';

const model = (patch: Partial<ResolvedModel>): ResolvedModel =>
  ({
    modelId: 'm',
    provider: 'openrouter',
    providerModelId: 'm',
    openRouterModelId: 'm',
    tier: 'light',
    isFree: false,
    ...patch,
  }) as ResolvedModel;

describe('reasoning display', () => {
  const freeZone = { candidateId: 'free-glm-5', providers: ['zai'], minDiscountPct: 85 };

  it('follows the switch for paid models', () => {
    expect(shouldRevealReasoning(false, model({}))).toBe(false);
    expect(shouldRevealReasoning(true, model({}))).toBe(true);
    expect(shouldRevealReasoning(false, model({ provider: 'surplus' }))).toBe(false);
  });

  it('always reveals for free-zone models, even with the switch off', () => {
    expect(shouldRevealReasoning(false, model({ provider: 'surplus', freeZone }))).toBe(true);
  });

  it('defaults to the thinking switch when no explicit reveal is set', () => {
    expect(revealsReasoning({})).toBe(true);
    expect(revealsReasoning({ thinkingEnabled: false })).toBe(false);
    expect(revealsReasoning({ thinkingEnabled: false, revealReasoning: true })).toBe(true);
  });
});
