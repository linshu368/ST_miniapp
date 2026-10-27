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

/** 非 VIP 且注册≤CHECKIN_NEW_USER_MAX_AGE_DAYS 天的每日签到绝对额。 */
export const CHECKIN_NEW_USER_CREDITS_CONFIG_KEY = 'miniapp_checkin_new_user_credits';
/** 非 VIP 且注册>CHECKIN_NEW_USER_MAX_AGE_DAYS 天的每日签到绝对额。 */
export const CHECKIN_VETERAN_CREDITS_CONFIG_KEY = 'miniapp_checkin_veteran_credits';
/** 遗留全员基础签到键；发奖不再读取，Admin 仍可编辑。 */
export const LEGACY_DAILY_CHECKIN_BONUS_CREDITS_CONFIG_KEY = 'miniapp_daily_checkin_bonus_credits';

export const CHECKIN_NEW_USER_MAX_AGE_DAYS = 14;
export const DEFAULT_CHECKIN_NEW_USER_CREDITS = 60;
export const DEFAULT_CHECKIN_VETERAN_CREDITS = 15;

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

/** VIP 每日签到绝对星尘额（非加成）。 */
export const VipCheckinBonusConfigSchema = z
  .number()
  .int()
  .min(0)
  .max(VIP_CHECKIN_FIXED_CREDITS_MAX);

export type VipCheckinBonusConfig = z.infer<typeof VipCheckinBonusConfigSchema>;

export const CheckinTierCreditsSchema = z.number().int().min(0).max(VIP_CHECKIN_FIXED_CREDITS_MAX);

export type CheckinTierCredits = z.infer<typeof CheckinTierCreditsSchema>;

export const CheckinRewardTierSchema = z.enum(['vip', 'new_user', 'veteran']);
export type CheckinRewardTier = z.infer<typeof CheckinRewardTierSchema>;

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

export const DEFAULT_VIP_CHECKIN_BONUS_CONFIG: VipCheckinBonusConfig = 150;

export const DEFAULT_FEATURE_FREE_TRIAL_LIMITS: FeatureFreeTrialLimits = {
  voice: FEATURE_FREE_TRIAL_LIMIT,
  basic_image: FEATURE_FREE_TRIAL_LIMIT,
};

/** VIP 有效时返回已发布绝对额，否则 0。 */
export function vipCheckinBonusCredits(input: {
  config: VipCheckinBonusConfig;
  vipActive: boolean;
}): number {
  if (!input.vipActive) return 0;
  return input.config;
}

export function registrationAgeDays(createdAt: string | Date, now: string | Date): number {
  const createdMs = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) {
    throw new Error('invalid registration timestamp');
  }
  return Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000));
}

export function parseCheckinTierCredits(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > VIP_CHECKIN_FIXED_CREDITS_MAX) {
    return fallback;
  }
  return parsed;
}

/**
 * 与 claim_daily_checkin 同口径：VIP 绝对额；非 VIP 按注册天数两档。
 * 返回字段保持 base + vip = reward。
 */
export function quoteTieredCheckinReward(input: {
  vipActive: boolean;
  createdAt: string | Date;
  now: string | Date;
  vipCredits: VipCheckinBonusConfig;
  newUserCredits: number;
  veteranCredits: number;
}): {
  base_reward_credits: number;
  vip_reward_credits: number;
  reward_credits: number;
  reward_tier: CheckinRewardTier;
  registration_age_days: number;
} {
  const ageDays = registrationAgeDays(input.createdAt, input.now);
  if (input.vipActive) {
    const vipReward = vipCheckinBonusCredits({
      config: input.vipCredits,
      vipActive: true,
    });
    return {
      base_reward_credits: 0,
      vip_reward_credits: vipReward,
      reward_credits: vipReward,
      reward_tier: 'vip',
      registration_age_days: ageDays,
    };
  }
  const base =
    ageDays <= CHECKIN_NEW_USER_MAX_AGE_DAYS ? input.newUserCredits : input.veteranCredits;
  if (!Number.isInteger(base) || base < 0) {
    throw new Error('invalid checkin tier reward');
  }
  return {
    base_reward_credits: base,
    vip_reward_credits: 0,
    reward_credits: base,
    reward_tier: ageDays <= CHECKIN_NEW_USER_MAX_AGE_DAYS ? 'new_user' : 'veteran',
    registration_age_days: ageDays,
  };
}
