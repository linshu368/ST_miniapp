import { describe, expect, it } from 'vitest';
import {
  CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  isQuotaTrackableCharacterId,
  resolveEffectiveModelMarkup,
} from './free-quota.js';

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

describe('isQuotaTrackableCharacterId', () => {
  it('accepts a platform character uuid regardless of case', () => {
    expect(isQuotaTrackableCharacterId('3f1b9c2e-4d5a-6b7c-8d9e-0f1a2b3c4d5e')).toBe(true);
    expect(isQuotaTrackableCharacterId('3F1B9C2E-4D5A-6B7C-8D9E-0F1A2B3C4D5E')).toBe(true);
  });

  it('rejects a missing or malformed character id', () => {
    expect(isQuotaTrackableCharacterId(null)).toBe(false);
    expect(isQuotaTrackableCharacterId(undefined)).toBe(false);
    expect(isQuotaTrackableCharacterId('')).toBe(false);
    expect(isQuotaTrackableCharacterId('42')).toBe(false);
    expect(isQuotaTrackableCharacterId('platform_3f1b9c2e-4d5a-6b7c-8d9e-0f1a2b3c4d5e.png')).toBe(
      false
    );
    expect(isQuotaTrackableCharacterId('3f1b9c2e4d5a6b7c8d9e0f1a2b3c4d5e')).toBe(false);
  });
});
