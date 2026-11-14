// 增长弹窗（进群 / VIP）的展示记录与判定所需的付费事实。存储见 migration 20261113_growth_prompt_states.sql。
// 写只经数据库函数：次数与间隔上限在一条语句里原子判定，多设备同时触发也不会超额。

import type { GrowthPromptEvent, GrowthPromptKind } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import type { PromptCap, PromptState } from '../../features/growth/prompt-rules.js';

export interface PaymentFacts {
  vipValidUntil: string | null;
  hasPaid: boolean;
}

export class GrowthPromptRepository {
  private get features() {
    return getDomainDb('miniapp_features');
  }

  async readStates(userId: string): Promise<Map<GrowthPromptKind, PromptState>> {
    const { data, error } = await this.features
      .from('growth_prompt_states')
      .select('prompt, shown_count, last_shown_at')
      .eq('user_id', userId);
    if (error) throw error;
    const rows = (data ?? []) as Array<PromptState & { prompt: GrowthPromptKind }>;
    return new Map(rows.map((row) => [row.prompt, row]));
  }

  async readPaymentFacts(userId: string): Promise<PaymentFacts> {
    const billing = getDomainDb('billing');
    const [membership, wallet] = await Promise.all([
      billing.from('vip_memberships').select('valid_until').eq('user_id', userId).maybeSingle(),
      billing.from('user_wallets').select('first_paid_at').eq('user_id', userId).maybeSingle(),
    ]);
    if (membership.error) throw membership.error;
    if (wallet.error) throw wallet.error;
    return {
      vipValidUntil:
        (membership.data as { valid_until: string | null } | null)?.valid_until ?? null,
      hasPaid: Boolean((wallet.data as { first_paid_at: string | null } | null)?.first_paid_at),
    };
  }

  /** shown 返回 false 表示已超额或未到间隔；accepted/dismissed 在没有展示记录时返回 false。 */
  async recordEvent(
    userId: string,
    kind: GrowthPromptKind,
    event: GrowthPromptEvent,
    cap: PromptCap
  ): Promise<boolean> {
    const { data, error } = await this.features.rpc('record_growth_prompt_event', {
      p_user_id: userId,
      p_prompt: kind,
      p_event: event,
      p_max_shows: cap.maxShows,
      p_min_interval_seconds: cap.minIntervalSeconds,
    });
    if (error) throw error;
    return (data as { recorded?: boolean } | null)?.recorded === true;
  }
}
