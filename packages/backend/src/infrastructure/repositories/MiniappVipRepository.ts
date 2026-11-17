import { getDomainDb } from '../../lib/supabase.js';
import { isVipPlanId, type VipPlanId } from '@miniapp/shared';
import { USER_MARK_KEYS, UserMarksRepository } from './UserMarksRepository.js';

export interface VipStatusSnapshot {
  valid_from: string | null;
  valid_until: string | null;
  last_plan_id: VipPlanId | null;
  entry_seen_at: string | null;
}

interface MembershipRow {
  valid_from: string;
  valid_until: string;
  last_plan_id: string;
}

export class MiniappVipRepository {
  private readonly billing = getDomainDb('billing');
  private readonly marks = new UserMarksRepository();

  async readSnapshot(userId: string): Promise<VipStatusSnapshot> {
    const [membershipResult, entrySeen] = await Promise.all([
      this.billing
        .from('vip_memberships')
        .select('valid_from, valid_until, last_plan_id')
        .eq('user_id', userId)
        .maybeSingle(),
      this.marks.readOne(userId, USER_MARK_KEYS.vipEntrySeen),
    ]);

    if (membershipResult.error) {
      throw new Error(`查询 VIP 会员失败：${membershipResult.error.message}`);
    }

    const membership = membershipResult.data as MembershipRow | null;
    const entrySeenAt = entrySeen?.first_at ?? null;
    if (!membership) {
      return {
        valid_from: null,
        valid_until: null,
        last_plan_id: null,
        entry_seen_at: entrySeenAt,
      };
    }
    if (!isVipPlanId(membership.last_plan_id)) {
      throw new Error('VIP 计划标识无效');
    }
    return {
      valid_from: membership.valid_from,
      valid_until: membership.valid_until,
      last_plan_id: membership.last_plan_id,
      entry_seen_at: entrySeenAt,
    };
  }

  /** 最近一次开通/续费的时间（畅聊开通礼从这里算）；走 (user_id, granted_at DESC) 索引 */
  async readLatestGrantAt(userId: string): Promise<string | null> {
    const { data, error } = await this.billing
      .from('vip_purchase_grants')
      .select('granted_at')
      .eq('user_id', userId)
      .order('granted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`查询 VIP 开通记录失败：${error.message}`, { cause: error });
    const grantedAt = (data as { granted_at?: unknown } | null)?.granted_at;
    return typeof grantedAt === 'string' ? grantedAt : null;
  }

  /**
   * 记录查看 VIP 入口。首次查看时间（first_at）写入后不再变，重装也不能把角标写回来。
   */
  async markEntryViewed(userId: string, seenAt: string): Promise<void> {
    await this.marks.touch(userId, USER_MARK_KEYS.vipEntrySeen, seenAt);
  }
}
