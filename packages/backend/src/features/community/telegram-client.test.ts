import { describe, expect, it } from 'vitest';
import { isActiveCommunityMember } from './telegram-client.js';

describe('isActiveCommunityMember', () => {
  it.each(['member', 'administrator', 'creator'])('accepts %s', (status) => {
    expect(isActiveCommunityMember(status)).toBe(true);
  });

  it.each(['left', 'kicked', 'restricted', 'unknown'])('rejects %s', (status) => {
    expect(isActiveCommunityMember(status)).toBe(false);
  });
});