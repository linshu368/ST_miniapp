import { describe, expect, it } from 'vitest';
import { FreeZoneConfigSchema } from '@miniapp/shared';
import { evaluateFreeZoneAccess, type FreeZoneAccessFacts } from '../free-zone/access.js';
import {
  canShowAgain,
  isCommunityPromptEligible,
  pickVipPromptContext,
  promptCap,
  vipPromptCap,
} from './prompt-rules.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-11-13T12:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
const frequency = { min_interval_days: 3, batch_size: 3, batch_cooldown_days: 30 };

describe('growth prompt rules', () => {
  it('limits community prompts to two, a day apart', () => {
    const cap = promptCap('community');
    expect(canShowAgain(undefined, cap, now)).toBe(true);
    expect(canShowAgain({ shown_count: 1, last_shown_at: at(23) }, cap, now)).toBe(false);
    expect(canShowAgain({ shown_count: 1, last_shown_at: at(25) }, cap, now)).toBe(true);
    expect(canShowAgain({ shown_count: 2, last_shown_at: at(100) }, cap, now)).toBe(false);
  });

  it('spaces VIP prompts three days apart and pauses 30 days after every third', () => {
    const show = (shown_count: number, hoursAgo: number) => {
      const state = { shown_count, last_shown_at: at(hoursAgo) };
      return canShowAgain(state, vipPromptCap(state, frequency), now);
    };
    expect(canShowAgain(undefined, vipPromptCap(undefined, frequency), now)).toBe(true);
    expect(show(1, 71)).toBe(false);
    expect(show(1, 73)).toBe(true);
    expect(show(2, 73)).toBe(true);
    expect(show(3, 73)).toBe(false);
    expect(show(3, 29 * 24)).toBe(false);
    expect(show(3, 30 * 24)).toBe(true);
    expect(show(4, 73)).toBe(true);
  });

  it('lets only one of two concurrent shows through via the count compare', () => {
    const state = { shown_count: 2, last_shown_at: at(100) };
    const cap = vipPromptCap(state, frequency);
    expect(cap.maxShows).toBe(3);
    // 另一台设备先记了一次：次数变 3，用旧上限 3 判定不再放行
    expect(canShowAgain({ shown_count: 3, last_shown_at: at(0) }, cap, now)).toBe(false);
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

describe('pickVipPromptContext', () => {
  const config = FreeZoneConfigSchema.parse({
    enabled: true,
    period: { starts_at: '2026-11-11T00:00:00+08:00', ends_at: '2026-11-22T00:00:00+08:00' },
    access: { enabled: true, trial_since: '2026-11-22T00:00:00+08:00' },
  });
  const bj = (local: string) => new Date(`${local}+08:00`);
  const pick = (
    nowLocal: string,
    facts: Partial<FreeZoneAccessFacts>,
    lastShown: string | null = null
  ) =>
    pickVipPromptContext({
      purchaseEnabled: true,
      access: evaluateFreeZoneAccess({
        config,
        now: bj(nowLocal),
        facts: {
          createdAt: '2026-11-15T10:00:00+08:00',
          vipValidUntil: null,
          lastVipGrantAt: null,
          ...facts,
        },
      }),
      state: lastShown ? { shown_count: 1, last_shown_at: `${lastShown}+08:00` } : undefined,
    });

  it('does not prompt members or users still in their trial', () => {
    expect(pick('2026-11-26T13:00:00', { vipValidUntil: '2026-12-31T00:00:00+08:00' })).toBeNull();
    expect(pick('2026-11-24T10:00:00', { createdAt: '2026-11-23T09:00:00+08:00' })).toBeNull();
  });

  it('prompts once after the trial ends, after the next round', () => {
    const newbie = { createdAt: '2026-11-23T09:00:00+08:00' };
    expect(pick('2026-11-26T10:00:00', newbie)).toEqual({
      context: 'trial_ended',
      afterNextRound: true,
    });
    // 结束之后已经弹过：不再用「刚结束」；当时又正好是畅聊日 → 畅聊日场景
    expect(pick('2026-11-26T13:00:00', newbie, '2026-11-26T10:30:00')).toEqual({
      context: 'vip_day',
      afterNextRound: false,
    });
  });

  it('prompts once when the welfare period ends, then on VIP days', () => {
    expect(pick('2026-11-23T10:00:00', {})).toEqual({
      context: 'welfare_ended',
      afterNextRound: true,
    });
    expect(pick('2026-11-23T10:00:00', {}, '2026-11-22T08:00:00')).toBeNull();
    expect(pick('2026-12-03T13:00:00', {}, '2026-11-22T08:00:00')?.context).toBe('vip_day');
    expect(pick('2026-12-04T13:00:00', {}, '2026-11-22T08:00:00')).toBeNull();
  });

  it('stays quiet when VIP purchase is off', () => {
    const result = pickVipPromptContext({
      purchaseEnabled: false,
      access: evaluateFreeZoneAccess({
        config,
        now: bj('2026-12-03T13:00:00'),
        facts: {
          createdAt: '2026-11-15T10:00:00+08:00',
          vipValidUntil: null,
          lastVipGrantAt: null,
        },
      }),
      state: undefined,
    });
    expect(result).toBeNull();
    expect(DAY).toBe(86_400_000);
  });
});
