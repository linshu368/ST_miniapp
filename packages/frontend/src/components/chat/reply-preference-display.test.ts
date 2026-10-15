import { describe, expect, it } from 'vitest';

import { claimReplyPreferenceGuide } from './reply-preference-display';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('claimReplyPreferenceGuide', () => {
  it('only claims the guide on the first chat-page visit', () => {
    const storage = memoryStorage();

    expect(claimReplyPreferenceGuide(storage)).toBe(true);
    expect(claimReplyPreferenceGuide(storage)).toBe(false);
  });

  it('does not show the guide when persistence is unavailable', () => {
    expect(claimReplyPreferenceGuide(null)).toBe(false);
    expect(
      claimReplyPreferenceGuide({
        getItem: () => null,
        setItem: () => {
          throw new Error('storage unavailable');
        },
      })
    ).toBe(false);
  });
});
