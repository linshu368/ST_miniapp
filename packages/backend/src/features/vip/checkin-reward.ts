import {
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  isVipActiveAt,
  vipCheckinBonusCredits,
  type VipCheckinBonusConfig,
} from '@miniapp/shared';

/** 预览口径与 claim_daily_checkin 一致：省略策略时按与基础奖励相同。实际发放仍以 RPC 为准。 */
export function quoteDailyCheckinReward(input: {
  baseRewardCredits: number;
  validUntil: string | null;
  now: string;
  bonus?: VipCheckinBonusConfig;
}): {
  base_reward_credits: number;
  vip_reward_credits: number;
  reward_credits: number;
} {
  if (!Number.isInteger(input.baseRewardCredits) || input.baseRewardCredits <= 0) {
    throw new Error('invalid checkin base reward');
  }
  const vipReward = vipCheckinBonusCredits({
    config: input.bonus ?? DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
    baseRewardCredits: input.baseRewardCredits,
    vipActive: isVipActiveAt(input.validUntil, input.now),
  });
  return {
    base_reward_credits: input.baseRewardCredits,
    vip_reward_credits: vipReward,
    reward_credits: input.baseRewardCredits + vipReward,
  };
}
