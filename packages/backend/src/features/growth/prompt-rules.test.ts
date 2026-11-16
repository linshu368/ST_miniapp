import { describe, expect, it } from 'vitest';
import { canShowAgain, isCommunityPromptEligible, promptCap } from './prompt-rules.js';

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-11-13T12:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();

describe('growth prompt rules', () => {
  it('limits community prompts to two, a day apart', () => {
    const cap = promptCap('community', false);
    expect(canShowAgain(undefined, cap, now)).toBe(true);
    expect(canShowAgain({ shown_count: 1, last_shown_at: at(23) }, cap, now)).toBe(false);
    expect(canShowAgain({ shown_count: 1, last_shown_at: at(25) }, cap, now)).toBe(true);
    expect(canShowAgain({ shown_count: 2, last_shown_at: at(100) }, cap, now)).toBe(false);
  });

  it('limits VIP prompts to three, three days apart, and once for paying users', () => {
    expect(
      canShowAgain({ shown_count: 1, last_shown_at: at(71) }, promptCap('vip', false), now)
    ).toBe(false);
    expect(
      canShowAgain({ shown_count: 2, last_shown_at: at(73) }, promptCap('vip', false), now)
    ).toBe(true);
    expect(
      canShowAgain({ shown_count: 1, last_shown_at: at(500) }, promptCap('vip', true), now)
    ).toBe(false);
  });

  it('never invites rewarded, pre-existing or current members to the community', () => {
    const base = { configured: true, claimed: false, excluded: false, inGroup: false };
    expect(isCommunityPromptEligible(base)).toBe(true);
    expect(isCommunityPromptEligible({ ...base, claimed: true })).toBe(false);
    expect(isCommunityPromptEligible({ ...base, excluded: true })).toBe(false);
    expect(isCommunityPromptEligible({ ...base, inGroup: true })).toBe(false);
    expect(isCommunityPromptEligible({ ...base, configured: false })).toBe(false);
  });
});
