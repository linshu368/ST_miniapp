import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 裂变邀请数据查询：一律走 admin.list_invite_records（106，SECURITY DEFINER，
 * 函数内鉴权）。invite 三表开了 RLS 且只授 service_role，任何 .from('invite_*')
 * 直查在 admin 侧都会被拒，属于错误路径。
 */

export const INVITE_RECORDS_PAGE_SIZE = 50;
export const INVITE_RECORDS_MAX_PAGE_SIZE = 200;

/** granted=已有到账，none=零到账；本期实时发放，没有"待批量更新"态。 */
export type InviteRewardStatusFilter = 'granted' | 'none';

export interface InviteRewardEntry {
  rule_key: string;
  credits: number;
  granted_at: string;
}

export interface InviteRecord {
  relation_id: string;
  inviter_user_id: string;
  inviter_tg_id: string | null;
  inviter_display_name: string | null;
  invitee_user_id: string;
  invitee_tg_id: string | null;
  invitee_display_name: string | null;
  invite_code: string;
  bound_at: string;
  reward_credits_total: number;
  reward_entries: InviteRewardEntry[];
  /** 筛选后的总行数（窗口计数，每行相同），供服务端分页。 */
  total_count: number;
}

export interface InviteRecordFilters {
  /** 邀请人：用户 UUID 或 Telegram ID。 */
  inviterRef?: string;
  /** 被邀请用户：用户 UUID 或 Telegram ID。 */
  inviteeRef?: string;
  /** 绑定时间闭开区间 [from, to)，ISO 字符串。 */
  boundFrom?: string;
  boundTo?: string;
  rewardStatus?: InviteRewardStatusFilter | null;
}

export interface InviteRecordsPage {
  records: InviteRecord[];
  total: number;
}

export async function listInviteRecords(input: {
  client: SupabaseClient;
  filters: InviteRecordFilters;
  limit: number;
  offset: number;
}): Promise<InviteRecordsPage> {
  const { data, error } = await input.client.schema('admin').rpc('list_invite_records', {
    p_inviter_ref: input.filters.inviterRef?.trim() || null,
    p_invitee_ref: input.filters.inviteeRef?.trim() || null,
    p_bound_from: input.filters.boundFrom ?? null,
    p_bound_to: input.filters.boundTo ?? null,
    p_reward_status: input.filters.rewardStatus ?? null,
    p_limit: input.limit,
    p_offset: input.offset,
  });
  if (error) throw new Error(error.message);
  const records = (data ?? []) as InviteRecord[];
  return { records, total: records[0]?.total_count ?? 0 };
}
