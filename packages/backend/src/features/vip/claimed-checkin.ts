export interface DailyCheckinRpcData {
  /** 已领取时间 */
  claimed_at: string;
  /** 下次领取时间 */
  next_claim_at: string;
  /** 奖励星尘 */
  reward_credits: number;
  /** 基础签到星尘 */
  base_reward_credits?: number;
  /** VIP 签到星尘 */
  vip_reward_credits?: number;
  main_reward_credits?: number;
  bonus_reward_credits?: number;
  /** 钱包 ledger ID */
  wallet_ledger_id?: string;
  vip_checkin_config_fallback?: boolean;
}

export function toClaimedCheckin(raw: DailyCheckinRpcData): {
  claimed_at: string;
  next_claim_at: string;
  reward_credits: number;
  base_reward_credits?: number;
  vip_reward_credits?: number;
  main_reward_credits?: number;
  bonus_reward_credits?: number;
} {
  const rewardCredits = readRewardInteger(raw.reward_credits);
  const baseRewardCredits =
    raw.base_reward_credits == null ? undefined : readRewardInteger(raw.base_reward_credits);
  const vipRewardCredits =
    raw.vip_reward_credits == null ? undefined : readRewardInteger(raw.vip_reward_credits);
  if (
    baseRewardCredits !== undefined &&
    vipRewardCredits !== undefined &&
    baseRewardCredits + vipRewardCredits !== rewardCredits
  ) {
    throw new Error('签到奖励拆分与总额不一致');
  }
  const main = readRewardInteger(raw.main_reward_credits ?? 0);
  const bonus = readRewardInteger(raw.bonus_reward_credits ?? rewardCredits);
  if (main + bonus !== rewardCredits) throw new Error('签到钱包拆分与总额不一致');
  return {
    main_reward_credits: main,
    bonus_reward_credits: bonus,
    claimed_at: raw.claimed_at,
    next_claim_at: raw.next_claim_at,
    reward_credits: rewardCredits,
    base_reward_credits: baseRewardCredits,
    vip_reward_credits: vipRewardCredits,
  };
}

function readRewardInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('签到奖励返回无效');
  }
  return parsed;
}
