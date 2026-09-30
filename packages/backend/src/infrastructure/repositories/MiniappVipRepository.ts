import { getDomainDb } from '../../lib/supabase.js';
import { isVipPlanId, type VipPlanId } from '@miniapp/shared';

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

interface SettingsSeenRow {
  vip_entry_seen_at: string | null;
}

export class MiniappVipRepository {
  private readonly billing = getDomainDb('billing');
  private readonly appCore = getDomainDb('app_core');

  async readSnapshot(userId: string): Promise<VipStatusSnapshot> {
    const [membershipResult, settingsResult] = await Promise.all([
      this.billing
        .from('vip_memberships')
        .select('valid_from, valid_until, last_plan_id')
        .eq('user_id', userId)
        .maybeSingle(),
      this.appCore
        .from('miniapp_user_settings')
        .select('vip_entry_seen_at')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    if (membershipResult.error) {
      throw new Error(`查询 VIP 会员失败：${membershipResult.error.message}`);
    }
    if (settingsResult.error) {
      throw new Error(`查询 VIP 入口状态失败：${settingsResult.error.message}`);
    }

    const membership = membershipResult.data as MembershipRow | null;
    const settings = settingsResult.data as SettingsSeenRow | null;
    if (!membership) {
      return {
        valid_from: null,
        valid_until: null,
        last_plan_id: null,
        entry_seen_at: settings?.vip_entry_seen_at ?? null,
      };
    }
    if (!isVipPlanId(membership.last_plan_id)) {
      throw new Error('VIP 计划标识无效');
    }
    return {
      valid_from: membership.valid_from,
      valid_until: membership.valid_until,
      last_plan_id: membership.last_plan_id,
      entry_seen_at: settings?.vip_entry_seen_at ?? null,
    };
  }

  /**
   * 只写当前用户的首次查看时间。已有时间戳时不再覆盖，重装也不能把角标写回来。
   */
  async markEntryViewed(userId: string, seenAt: string): Promise<void> {
    const { data, error } = await this.appCore
      .from('miniapp_user_settings')
      .update({ vip_entry_seen_at: seenAt, updated_at: seenAt })
      .eq('user_id', userId)
      .is('vip_entry_seen_at', null)
      .select('user_id')
      .maybeSingle();
    if (error) throw new Error(`标记 VIP 入口已查看失败：${error.message}`);
    if (data) return;

    const { data: existing, error: readError } = await this.appCore
      .from('miniapp_user_settings')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (readError) throw new Error(`查询 VIP 入口状态失败：${readError.message}`);
    if (existing) return;

    const { error: insertError } = await this.appCore.from('miniapp_user_settings').insert({
      user_id: userId,
      vip_entry_seen_at: seenAt,
    });
    if (!insertError) return;

    const { data: afterRace, error: afterError } = await this.appCore
      .from('miniapp_user_settings')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (afterError || !afterRace) {
      throw new Error(`标记 VIP 入口已查看失败：${insertError.message}`);
    }
  }
}
