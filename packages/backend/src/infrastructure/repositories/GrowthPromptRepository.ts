// 增长弹窗（进群 / VIP）的展示记录与判定所需的付费事实。展示记录存在 features.user_marks
// （mark_key = growth_prompt.<kind>，见 migration 20261117_db_reorg_p3b1_user_marks.sql）。
// 写只经数据库函数：次数与间隔上限在一条语句里原子判定，多设备同时触发也不会超额。

import type { GrowthPromptEvent, GrowthPromptKind } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import type { PromptCap, PromptState } from '../../features/growth/prompt-rules.js';
import { USER_MARK_KEYS, UserMarksRepository, type UserMarkKey } from './UserMarksRepository.js';

export interface PaymentFacts {
  vipValidUntil: string | null;
  hasPaid: boolean;
}

const PROMPT_MARK_KEYS: Record<GrowthPromptKind, UserMarkKey> = {
  community: USER_MARK_KEYS.growthPromptCommunity,
  vip: USER_MARK_KEYS.growthPromptVip,
};

export class GrowthPromptRepository {
  private readonly marks = new UserMarksRepository();

  private get features() {
    return getDomainDb('features');
  }

  async readStates(userId: string): Promise<Map<GrowthPromptKind, PromptState>> {
    const kinds = Object.keys(PROMPT_MARK_KEYS) as GrowthPromptKind[];
    const marks = await this.marks.read(
      userId,
      kinds.map((kind) => PROMPT_MARK_KEYS[kind])
    );
    const states = new Map<GrowthPromptKind, PromptState>();
    for (const kind of kinds) {
      const mark = marks.get(PROMPT_MARK_KEYS[kind]);
      if (mark) states.set(kind, { shown_count: mark.count, last_shown_at: mark.last_at });
    }
    return states;
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
