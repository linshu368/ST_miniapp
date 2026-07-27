import { describe, expect, it } from 'vitest';
import { CHARACTER_FREE_CHAT_QUOTA_LIMIT, resolveEffectiveModelMarkup } from './free-quota.js';

describe('character free chat quota pricing', () => {
  it('keeps a free model free while quota is granted', () => {
    expect(resolveEffectiveModelMarkup(0, 3, true)).toBe(0);
  });

  it('uses deduct markup after a free model quota is exhausted', () => {
    expect(resolveEffectiveModelMarkup(0, 3, false)).toBe(3);
  });

  it('does not change paid model markup', () => {
    expect(resolveEffectiveModelMarkup(1.5, 3, false)).toBe(1.5);
  });

  it('uses a 50-round limit', () => {
    expect(CHARACTER_FREE_CHAT_QUOTA_LIMIT).toBe(50);
  });
});
