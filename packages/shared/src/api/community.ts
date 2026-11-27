/** 官方 Telegram 社群入口与一次性入群奖励契约。 */
export type CommunityClaimStatus = 'unclaimed' | 'existing_member' | 'rewarded' | 'ineligible';

export interface CommunityEntryData {
  enabled: boolean;
  title: string;
  description: string;
  reward_credits: number;
  telegram_url: string;
  fallback_handle: string;
  claim_status: CommunityClaimStatus;
  rewarded_at: string | null;
}

export type VerifyCommunityMembershipStatus =
  | 'rewarded'
  | 'already_rewarded'
  | 'not_member'
  | 'pending'
  | 'ineligible'
  | 'disabled';

export interface VerifyCommunityMembershipData {
  status: VerifyCommunityMembershipStatus;
  reward_credits: number;
  rewarded_at: string | null;
}

export type CommunityGroupCheckinStatus = 'claimed' | 'already_claimed' | 'not_registered';

export interface CommunityGroupCheckinData {
  status: CommunityGroupCheckinStatus;
  reward_credits?: number;
  base_reward_credits?: number;
  vip_reward_credits?: number;
  next_claim_at?: string;
}
