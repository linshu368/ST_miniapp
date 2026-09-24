import { z } from 'zod';

import { FEATURE_FREE_TRIAL_LIMIT, FeatureFreeTrialLimitSchema } from './feature-free-trials.js';
import {
  VIP_PLAN_BONUS_CREDITS_MAX,
  VIP_PLAN_COMMERCIAL_TERMS,
  VIP_PLAN_DURATION_DAYS_MAX,
  VIP_PLAN_PRICE_CENTS_MAX,
  VIP_TEXT_DISCOUNT_RATE,
  type VipPlanId,
} from './vip.js';

export const VIP_PURCHASE_ENABLED_CONFIG_KEY = 'vip_purchase_enabled';
export const VIP_REMINDERS_ENABLED_CONFIG_KEY = 'vip_reminders_enabled';
export const VIP_PLANS_CONFIG_KEY = 'vip_plans_config';
export const VIP_TEXT_DISCOUNT_RATE_CONFIG_KEY = 'vip_text_discount_rate';
export const VIP_CHECKIN_BONUS_CONFIG_KEY = 'vip_checkin_bonus_config';
export const FEATURE_FREE_TRIAL_LIMITS_CONFIG_KEY = 'feature_free_trial_limits';

export const VIP_STRATEGY_CONFIG_KEYS = [
  VIP_PURCHASE_ENABLED_CONFIG_KEY,
  VIP_REMINDERS_ENABLED_CONFIG_KEY,
  VIP_PLANS_CONFIG_KEY,
  VIP_TEXT_DISCOUNT_RATE_CONFIG_KEY,
  VIP_CHECKIN_BONUS_CONFIG_KEY,
  FEATURE_FREE_TRIAL_LIMITS_CONFIG_KEY,
] as const;

export type VipStrategyConfigKey = (typeof VIP_STRATEGY_CONFIG_KEYS)[number];

export const VIP_CHECKIN_FIXED_CREDITS_MAX = 1_000_000;

const positiveCents = z.number().int().min(1).max(VIP_PLAN_PRICE_CENTS_MAX);
const positiveDays = z.number().int().min(1).max(VIP_PLAN_DURATION_DAYS_MAX);
const nonnegativeCredits = z.number().int().min(0).max(VIP_PLAN_BONUS_CREDITS_MAX);

export const VipPlanTermsSchema = z
  .object({
    price_cents: positiveCents,
    duration_days: positiveDays,
    bonus_credits: nonnegativeCredits,
    title: z.string().trim().min(1).max(40),
    description: z.string().trim().max(200).nullable(),
    badge_text: z.string().trim().min(1).max(40).nullable(),
  })
  .strict();

export type VipPlanTerms = z.infer<typeof VipPlanTermsSchema>;

export const VipPlansConfigSchema = z
  .object({
    week: VipPlanTermsSchema,
    month: VipPlanTermsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.week.bonus_credits !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['week', 'bonus_credits'],
        message: '周卡赠送必须为 0',
      });
    }
  });

export type VipPlansConfig = z.infer<typeof VipPlansConfigSchema>;

export const VipTextDiscountRateSchema = z.number().finite().gt(0).lte(1);
export type VipTextDiscountRate = z.infer<typeof VipTextDiscountRateSchema>;

export const VipCheckinBonusConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('same_as_base') }).strict(),
  z
    .object({
      mode: z.literal('fixed'),
      fixed_credits: z.number().int().min(0).max(VIP_CHECKIN_FIXED_CREDITS_MAX),
    })
    .strict(),
]);

export type VipCheckinBonusConfig = z.infer<typeof VipCheckinBonusConfigSchema>;

export const FeatureFreeTrialLimitsSchema = z
  .object({
    voice: FeatureFreeTrialLimitSchema,
    basic_image: FeatureFreeTrialLimitSchema,
  })
  .strict();

export type FeatureFreeTrialLimits = z.infer<typeof FeatureFreeTrialLimitsSchema>;

export const VipFeatureSwitchSchema = z.boolean();

function defaultPlanTerms(
  planId: VipPlanId,
  copy: { title: string; description: string }
): VipPlanTerms {
  const terms = VIP_PLAN_COMMERCIAL_TERMS[planId];
  return {
    price_cents: terms.price_cents,
    duration_days: terms.duration_days,
    bonus_credits: terms.bonus_credits,
    title: copy.title,
    description: copy.description,
    badge_text: null,
  };
}

export const DEFAULT_VIP_PLANS_CONFIG: VipPlansConfig = {
  week: defaultPlanTerms('week', { title: '周卡', description: '7 天 VIP' }),
  month: defaultPlanTerms('month', {
    title: '月卡',
    description: '31 天 VIP，赠送 3000 专项星尘',
  }),
};

export const DEFAULT_VIP_TEXT_DISCOUNT_RATE: VipTextDiscountRate = VIP_TEXT_DISCOUNT_RATE;

export const DEFAULT_VIP_CHECKIN_BONUS_CONFIG: VipCheckinBonusConfig = { mode: 'same_as_base' };

export const DEFAULT_FEATURE_FREE_TRIAL_LIMITS: FeatureFreeTrialLimits = {
  voice: FEATURE_FREE_TRIAL_LIMIT,
  basic_image: FEATURE_FREE_TRIAL_LIMIT,
};

export function vipCheckinBonusCredits(input: {
  config: VipCheckinBonusConfig;
  baseRewardCredits: number;
  vipActive: boolean;
}): number {
  if (!input.vipActive) return 0;
  if (input.config.mode === 'fixed') return input.config.fixed_credits;
  return input.baseRewardCredits;
}
