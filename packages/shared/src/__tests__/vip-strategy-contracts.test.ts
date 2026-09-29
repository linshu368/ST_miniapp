import { describe, expect, it } from 'vitest';

import {
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
    expect(DEFAULT_VIP_CHECKIN_BONUS_CONFIG).toEqual({ mode: 'same_as_base' });
    expect(DEFAULT_FEATURE_FREE_TRIAL_LIMITS).toEqual({ voice: 3, basic_image: 3 });
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

    expect(VipCheckinBonusConfigSchema.safeParse({ mode: 'same_as_base' }).success).toBe(true);
    expect(VipCheckinBonusConfigSchema.safeParse({ mode: 'fixed', fixed_credits: 0 }).success).toBe(
      true
    );
    expect(VipCheckinBonusConfigSchema.safeParse({ mode: 'fixed' }).success).toBe(false);
    expect(
      VipCheckinBonusConfigSchema.safeParse({ mode: 'same_as_base', fixed_credits: 10 }).success
    ).toBe(false);
    expect(
      VipCheckinBonusConfigSchema.safeParse({ mode: 'fixed', fixed_credits: -1 }).success
    ).toBe(false);

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

  it('uses the same check-in bonus for a preview and the published mode', () => {
    expect(
      vipCheckinBonusCredits({
        config: { mode: 'same_as_base' },
        baseRewardCredits: 60,
        vipActive: true,
      })
    ).toBe(60);
    expect(
      vipCheckinBonusCredits({
        config: { mode: 'fixed', fixed_credits: 10 },
        baseRewardCredits: 60,
        vipActive: true,
      })
    ).toBe(10);
    expect(
      vipCheckinBonusCredits({
        config: { mode: 'fixed', fixed_credits: 10 },
        baseRewardCredits: 60,
        vipActive: false,
      })
    ).toBe(0);
  });
});
