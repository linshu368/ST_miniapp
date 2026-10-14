import { describe, expect, it } from 'vitest';

import {
  CHECKIN_NEW_USER_MAX_AGE_DAYS,
  DEFAULT_CHECKIN_NEW_USER_CREDITS,
  DEFAULT_CHECKIN_VETERAN_CREDITS,
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  FeatureFreeTrialLimitsSchema,
  VIP_PLAN_COMMERCIAL_TERMS,
  VipCheckinBonusConfigSchema,
  VipPlansConfigSchema,
  VipTextDiscountRateSchema,
  formatCentsAsYuan,
  quoteTieredCheckinReward,
  registrationAgeDays,
  vipCheckinBonusCredits,
} from '../index.js';

describe('VIP strategy defaults', () => {
  it('seeds the current purchase, discount, check-in and free-trial behavior', () => {
    expect(DEFAULT_VIP_PLANS_CONFIG.week).toMatchObject({
      price_cents: VIP_PLAN_COMMERCIAL_TERMS.week.price_cents,
      duration_days: VIP_PLAN_COMMERCIAL_TERMS.week.duration_days,
      bonus_credits: 0,
      title: '周卡',
      badge_text: null,
    });
    expect(DEFAULT_VIP_PLANS_CONFIG.month).toMatchObject({
      price_cents: VIP_PLAN_COMMERCIAL_TERMS.month.price_cents,
      duration_days: VIP_PLAN_COMMERCIAL_TERMS.month.duration_days,
      bonus_credits: 3000,
      title: '月卡',
    });
    expect(DEFAULT_VIP_TEXT_DISCOUNT_RATE).toBe(0.95);
    expect(DEFAULT_VIP_CHECKIN_BONUS_CONFIG).toBe(150);
    expect(DEFAULT_FEATURE_FREE_TRIAL_LIMITS).toEqual({ voice: 3, basic_image: 3 });
    expect(DEFAULT_CHECKIN_NEW_USER_CREDITS).toBe(60);
    expect(DEFAULT_CHECKIN_VETERAN_CREDITS).toBe(15);
    expect(CHECKIN_NEW_USER_MAX_AGE_DAYS).toBe(14);
    expect(formatCentsAsYuan(1399)).toBe('13.99');
    expect(formatCentsAsYuan(2888)).toBe('28.88');
    expect(formatCentsAsYuan(5)).toBe('0.05');
  });
});

describe('VIP strategy schemas', () => {
  it('rejects illegal plan, discount, check-in and free-trial values', () => {
    expect(VipPlansConfigSchema.safeParse(DEFAULT_VIP_PLANS_CONFIG).success).toBe(true);
    expect(
      VipPlansConfigSchema.safeParse({
        ...DEFAULT_VIP_PLANS_CONFIG,
        week: { ...DEFAULT_VIP_PLANS_CONFIG.week, bonus_credits: 1 },
      }).success
    ).toBe(false);
    expect(
      VipPlansConfigSchema.safeParse({
        ...DEFAULT_VIP_PLANS_CONFIG,
        week: { ...DEFAULT_VIP_PLANS_CONFIG.week, price_cents: 13.99 },
      }).success
    ).toBe(false);
    expect(
      VipPlansConfigSchema.safeParse({
        ...DEFAULT_VIP_PLANS_CONFIG,
        month: { ...DEFAULT_VIP_PLANS_CONFIG.month, duration_days: 0 },
      }).success
    ).toBe(false);
    expect(
      VipPlansConfigSchema.safeParse({
        ...DEFAULT_VIP_PLANS_CONFIG,
        quarter: DEFAULT_VIP_PLANS_CONFIG.week,
      }).success
    ).toBe(false);

    expect(VipTextDiscountRateSchema.safeParse(0.95).success).toBe(true);
    expect(VipTextDiscountRateSchema.safeParse(1).success).toBe(true);
    expect(VipTextDiscountRateSchema.safeParse(0).success).toBe(false);
    expect(VipTextDiscountRateSchema.safeParse(1.01).success).toBe(false);

    expect(VipCheckinBonusConfigSchema.safeParse(150).success).toBe(true);
    expect(VipCheckinBonusConfigSchema.safeParse(0).success).toBe(true);
    expect(VipCheckinBonusConfigSchema.safeParse({ mode: 'same_as_base' }).success).toBe(false);
    expect(
      VipCheckinBonusConfigSchema.safeParse({ mode: 'fixed', fixed_credits: 10 }).success
    ).toBe(false);
    expect(VipCheckinBonusConfigSchema.safeParse(-1).success).toBe(false);

    expect(FeatureFreeTrialLimitsSchema.safeParse({ voice: 0, basic_image: 20 }).success).toBe(
      true
    );
    expect(FeatureFreeTrialLimitsSchema.safeParse({ voice: 3, basic_image: 3 }).success).toBe(true);
    expect(FeatureFreeTrialLimitsSchema.safeParse({ voice: -1, basic_image: 3 }).success).toBe(
      false
    );
    expect(FeatureFreeTrialLimitsSchema.safeParse({ voice: 21, basic_image: 3 }).success).toBe(
      false
    );
    expect(FeatureFreeTrialLimitsSchema.safeParse({ voice: 1.5, basic_image: 3 }).success).toBe(
      false
    );
    expect(FeatureFreeTrialLimitsSchema.safeParse({ voice: 3 }).success).toBe(false);
  });

  it('quotes absolute VIP credits and registration-age tiers', () => {
    expect(
      vipCheckinBonusCredits({
        config: 150,
        vipActive: true,
      })
    ).toBe(150);
    expect(
      vipCheckinBonusCredits({
        config: 150,
        vipActive: false,
      })
    ).toBe(0);

    const now = '2026-10-14T00:00:00.000Z';
    expect(
      quoteTieredCheckinReward({
        vipActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
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
      registration_age_days: registrationAgeDays('2026-01-01T00:00:00.000Z', now),
    });
    expect(
      quoteTieredCheckinReward({
        vipActive: false,
        createdAt: '2026-10-10T00:00:00.000Z',
        now,
        vipCredits: 150,
        newUserCredits: 60,
        veteranCredits: 15,
      }).reward_tier
    ).toBe('new_user');
    expect(
      quoteTieredCheckinReward({
        vipActive: false,
        createdAt: '2026-09-01T00:00:00.000Z',
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
});
