import { describe, expect, it } from 'vitest';

import { quoteDailyCheckinReward } from './checkin-reward.js';

const NOW = '2026-09-22T00:00:00.000Z';

describe('quoteDailyCheckinReward', () => {
  it('pays the base amount when there is no membership', () => {
    expect(quoteDailyCheckinReward({ baseRewardCredits: 60, validUntil: null, now: NOW })).toEqual({
      base_reward_credits: 60,
      vip_reward_credits: 0,
      reward_credits: 60,
    });
  });

  it('adds the same base amount once for an active VIP', () => {
    expect(
      quoteDailyCheckinReward({
        baseRewardCredits: 60,
        validUntil: '2026-10-01T00:00:00.000Z',
        now: NOW,
      })
    ).toEqual({
      base_reward_credits: 60,
      vip_reward_credits: 60,
      reward_credits: 120,
    });
  });

  it('drops the bonus at the exact expiry instant and after it', () => {
    expect(
      quoteDailyCheckinReward({ baseRewardCredits: 60, validUntil: NOW, now: NOW })
    ).toMatchObject({
      vip_reward_credits: 0,
      reward_credits: 60,
    });
    expect(
      quoteDailyCheckinReward({
        baseRewardCredits: 60,
        validUntil: '2026-09-21T23:59:59.999Z',
        now: NOW,
      }).reward_credits
    ).toBe(60);
  });

  it('uses one timestamp for the boundary one millisecond later', () => {
    expect(
      quoteDailyCheckinReward({
        baseRewardCredits: 60,
        validUntil: '2026-09-22T00:00:00.001Z',
        now: NOW,
      }).reward_credits
    ).toBe(120);
  });
});
