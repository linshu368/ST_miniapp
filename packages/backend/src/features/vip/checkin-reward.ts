import { isVipActiveAt } from '@miniapp/shared';

/** 签到预览与数据库发放共用：基础额来自配置，有效 VIP 再加同等基础额。 */
export function quoteDailyCheckinReward(input: {
  baseRewardCredits: number;
  validUntil: string | null;
  now: string;
}): {
  base_reward_credits: number;
  vip_reward_credits: number;
  reward_credits: number;
} {
  if (!Number.isInteger(input.baseRewardCredits) || input.baseRewardCredits <= 0) {
    throw new Error('invalid checkin base reward');
  }
  const vipReward = isVipActiveAt(input.validUntil, input.now) ? input.baseRewardCredits : 0;
  return {
    base_reward_credits: input.baseRewardCredits,
    vip_reward_credits: vipReward,
    reward_credits: input.baseRewardCredits + vipReward,
  };
}
