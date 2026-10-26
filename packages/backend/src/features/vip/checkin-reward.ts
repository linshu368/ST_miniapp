import {
  DEFAULT_CHECKIN_NEW_USER_CREDITS,
  DEFAULT_CHECKIN_VETERAN_CREDITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  isVipActiveAt,
  quoteTieredCheckinReward,
  type VipCheckinBonusConfig,
} from '@miniapp/shared';

/** 预览口径与 claim_daily_checkin 一致。实际发放仍以 RPC 为准。 */
export function quoteDailyCheckinReward(input: {
  createdAt: string;
  validUntil: string | null;
  now: string;
  vipCredits?: VipCheckinBonusConfig;
  newUserCredits?: number;
  veteranCredits?: number;
}): {
  base_reward_credits: number;
  vip_reward_credits: number;
  reward_credits: number;
  reward_tier: 'vip' | 'new_user' | 'veteran';
  registration_age_days: number;
} {
  const quote = quoteTieredCheckinReward({
    vipActive: isVipActiveAt(input.validUntil, input.now),
    createdAt: input.createdAt,
    now: input.now,
    vipCredits: input.vipCredits ?? DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
    newUserCredits: input.newUserCredits ?? DEFAULT_CHECKIN_NEW_USER_CREDITS,
    veteranCredits: input.veteranCredits ?? DEFAULT_CHECKIN_VETERAN_CREDITS,
  });
  if (!Number.isInteger(quote.reward_credits) || quote.reward_credits <= 0) {
    throw new Error('invalid checkin reward');
  }
  return quote;
}
