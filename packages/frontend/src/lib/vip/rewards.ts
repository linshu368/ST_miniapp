import type { VipPlan, VipStatus } from '@miniapp/shared';
import { formatNumber } from '@/lib/utils/payment';

export function rewardSplitLabel(bonus: number, main: number): string {
  if (main <= 0) return `${formatNumber(bonus)} 专项星尘`;
  if (bonus <= 0) return `${formatNumber(main)} 通用星尘`;
  return `${formatNumber(bonus)} 专项＋${formatNumber(main)} 通用星尘`;
}

export function vipPlanRewardLabel(
  plan: Pick<VipPlan, 'bonus_credits' | 'bonus_main_credits'>
): string {
  return rewardSplitLabel(plan.bonus_credits, plan.bonus_main_credits ?? 0);
}

export function vipCheckinRewardLabel(benefits: NonNullable<VipStatus['benefits']>): string {
  return rewardSplitLabel(
    benefits.checkin_bonus_credits ?? benefits.checkin_vip_credits,
    benefits.checkin_main_credits ?? 0
  );
}
