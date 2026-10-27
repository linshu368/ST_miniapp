import { describe, expect, it } from 'vitest';

import { quoteDailyCheckinReward } from './checkin-reward.js';

describe('quoteDailyCheckinReward', () => {
  const now = '2026-10-14T12:00:00.000Z';

  it('quotes new-user non-VIP tier', () => {
    expect(
      quoteDailyCheckinReward({
        createdAt: '2026-10-10T00:00:00.000Z',
        validUntil: null,
        now,
        vipCredits: 150,
        newUserCredits: 60,
        veteranCredits: 15,
      })
    ).toMatchObject({
      base_reward_credits: 60,
      vip_reward_credits: 0,
      reward_credits: 60,
      reward_tier: 'new_user',
    });
  });

  it('quotes veteran non-VIP tier', () => {
    expect(
      quoteDailyCheckinReward({
        createdAt: '2026-01-01T00:00:00.000Z',
        validUntil: null,
        now,
        vipCredits: 150,
        newUserCredits: 60,
        veteranCredits: 15,
      })
    ).toMatchObject({
      base_reward_credits: 15,
      vip_reward_credits: 0,
      reward_credits: 15,
      reward_tier: 'veteran',
    });
  });

  it('quotes absolute VIP credits regardless of registration age', () => {
    expect(
      quoteDailyCheckinReward({
        createdAt: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-10-20T00:00:00.000Z',
        now,
        vipCredits: 150,
        newUserCredits: 60,
        veteranCredits: 15,
      })
    ).toEqual({
      base_reward_credits: 0,
      vip_reward_credits: 150,
      reward_credits: 150,
      reward_tier: 'vip',
      registration_age_days: expect.any(Number),
    });
  });

  it('ignores VIP absolute amount when membership is inactive', () => {
    expect(
      quoteDailyCheckinReward({
        createdAt: '2026-10-10T00:00:00.000Z',
        validUntil: '2026-10-01T00:00:00.000Z',
        now,
        vipCredits: 150,
        newUserCredits: 60,
        veteranCredits: 15,
      }).vip_reward_credits
    ).toBe(0);
  });
});
