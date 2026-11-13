import { getDomainDb } from '../../lib/supabase.js';
import { isActiveCommunityMember } from './telegram-client.js';

export interface CommunityClaimFacts {
  /** 已领过入群奖励的时间；null = 未领 */
  grantedAt: string | null;
  /** 活动开始时已在群里的成员（走手动验证，不走 webhook 发奖） */
  excluded: boolean;
}

/** 社群入口与增长弹窗共用的领奖事实，保证两处口径一致。 */
export async function readCommunityClaimFacts(
  userId: string,
  telegramUserId: string,
  chatId: string
): Promise<CommunityClaimFacts> {
  const db = getDomainDb('miniapp_features');
  const [claim, exclusion] = await Promise.all([
    db
      .from('community_reward_claims')
      .select('granted_at')
      .eq('user_id', userId)
      .eq('community_chat_id', chatId)
      .maybeSingle(),
    db
      .from('community_reward_exclusions')
      .select('telegram_user_id')
      .eq('community_chat_id', chatId)
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle(),
  ]);
  if (claim.error) throw claim.error;
  if (exclusion.error) throw exclusion.error;
  return {
    grantedAt: (claim.data as { granted_at: string } | null)?.granted_at ?? null,
    excluded: Boolean(exclusion.data),
  };
}

/**
 * 按 bot 收到的最近一次成员变化判断此人现在是否在群里。
 * 收据只覆盖活动开始后的变化；更早就在群里的人已在排除名单里，不依赖这里。
 */
export async function isInCommunityByReceipts(
  telegramUserId: string,
  chatId: string
): Promise<boolean> {
  const { data, error } = await getDomainDb('miniapp_features')
    .from('telegram_community_update_receipts')
    .select('new_status')
    .eq('community_chat_id', chatId)
    .eq('telegram_user_id', telegramUserId)
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const status = (data as { new_status: string } | null)?.new_status;
  return status === 'restricted' || (status !== undefined && isActiveCommunityMember(status));
}

/** 这次之前是否已有过一次有效入群（用于「没账号的人只欢迎一次」）。 */
export async function hasEarlierEligibleJoin(
  telegramUserId: string,
  chatId: string,
  updateId: number
): Promise<boolean> {
  const { data, error } = await getDomainDb('miniapp_features')
    .from('telegram_community_update_receipts')
    .select('update_id')
    .eq('community_chat_id', chatId)
    .eq('telegram_user_id', telegramUserId)
    .eq('eligible', true)
    .neq('update_id', updateId)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
