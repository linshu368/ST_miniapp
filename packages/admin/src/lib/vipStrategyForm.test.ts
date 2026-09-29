import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  FeatureFreeTrialLimitsSchema,
  VipCheckinBonusConfigSchema,
  VipPlansConfigSchema,
  VipTextDiscountRateSchema,
} from '@miniapp/shared';
import { configSchemas } from './configSchemas';
import { blankToNull, checkinConfig, vipPriceLabel } from './vipStrategyForm';

describe('VIP strategy form', () => {
  it('shows yuan from integer cents and keeps week bonus at zero', () => {
    expect(vipPriceLabel(1399)).toBe('13.99 元');
    expect(vipPriceLabel(2888)).toBe('28.88 元');
    expect(vipPriceLabel(5)).toBe('0.05 元');
    const week = {
      ...DEFAULT_VIP_PLANS_CONFIG,
      week: { ...DEFAULT_VIP_PLANS_CONFIG.week, price_cents: 1500 },
    };
    expect(configSchemas.vip_plans_config.safeParse(week).success).toBe(true);
    expect(
      VipPlansConfigSchema.safeParse({
        ...week,
        week: { ...week.week, bonus_credits: 1 },
      }).success
    ).toBe(false);
    expect(
      configSchemas.vip_plans_config.safeParse({
        ...DEFAULT_VIP_PLANS_CONFIG,
        week: { ...DEFAULT_VIP_PLANS_CONFIG.week, price_cents: 13.99 },
      }).success
    ).toBe(false);
  });

  it('only accepts a fixed bonus value in fixed mode', () => {
    expect(checkinConfig('same_as_base', 10)).toEqual({ mode: 'same_as_base' });
    expect(checkinConfig('fixed', 0)).toEqual({ mode: 'fixed', fixed_credits: 0 });
    expect(VipCheckinBonusConfigSchema.safeParse(DEFAULT_VIP_CHECKIN_BONUS_CONFIG).success).toBe(
      true
    );
    expect(configSchemas.vip_checkin_bonus_config.safeParse({ mode: 'fixed' }).success).toBe(false);
    expect(
      configSchemas.vip_checkin_bonus_config.safeParse({
        mode: 'same_as_base',
        fixed_credits: 10,
      }).success
    ).toBe(false);
    expect(blankToNull('  ')).toBeNull();
    expect(blankToNull('角标')).toBe('角标');
  });

  it('rejects discount and free-trial values outside the shared bounds', () => {
    expect(configSchemas.vip_text_discount_rate.safeParse(0.95).success).toBe(true);
    expect(VipTextDiscountRateSchema.safeParse(0).success).toBe(false);
    expect(configSchemas.vip_text_discount_rate.safeParse(1.01).success).toBe(false);
    expect(
      configSchemas.feature_free_trial_limits.safeParse(DEFAULT_FEATURE_FREE_TRIAL_LIMITS).success
    ).toBe(true);
    expect(FeatureFreeTrialLimitsSchema.safeParse({ voice: 0, basic_image: 20 }).success).toBe(
      true
    );
    expect(
      configSchemas.feature_free_trial_limits.safeParse({ voice: 21, basic_image: 3 }).success
    ).toBe(false);
    expect(
      configSchemas.feature_free_trial_limits.safeParse({ voice: 3.5, basic_image: 3 }).success
    ).toBe(false);
    expect(configSchemas.vip_purchase_enabled.safeParse(false).success).toBe(true);
    expect(configSchemas.vip_purchase_enabled.safeParse('false').success).toBe(false);
    expect(configSchemas.vip_reminders_enabled.safeParse(true).success).toBe(true);
  });
});
