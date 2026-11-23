// 用户一次性/水位类 UI 标记（看过、做过、弹过几次）。存储见 migration 20261117_db_reorg_p3b1_user_marks.sql。
// 表只读；写只经数据库函数，计数与水位在一条 upsert 里完成，多端同时触发不会丢次数。

import { getDomainDb } from '../../lib/supabase.js';

/** mark_key = <功能>.<事件>；新标记不改表，在这里登记即可。 */
export const USER_MARK_KEYS = {
  vipEntrySeen: 'vip_entry.seen',
  charactersLatestSeen: 'characters_latest.seen',
  growthPromptCommunity: 'growth_prompt.community',
  growthPromptVip: 'growth_prompt.vip',
} as const;

export type UserMarkKey = (typeof USER_MARK_KEYS)[keyof typeof USER_MARK_KEYS];

export interface UserMark {
  mark_key: string;
  count: number;
  /** 第一次发生的时间，写入后不变。 */
  first_at: string | null;
  /** 最近一次发生的时间（水位）。 */
  last_at: string | null;
  last_action: string | null;
  last_action_at: string | null;
}

const MARK_COLUMNS = 'mark_key, count, first_at, last_at, last_action, last_action_at';
const MARK_TIMEOUT_MS = 5_000;

export class UserMarksRepository {
  private get features() {
    return getDomainDb('features');
  }

  async read(userId: string, keys: readonly UserMarkKey[]): Promise<Map<string, UserMark>> {
    const { data, error } = await this.features
      .from('user_marks')
      .select(MARK_COLUMNS)
      .eq('user_id', userId)
      .in('mark_key', [...keys])
      .abortSignal(AbortSignal.timeout(MARK_TIMEOUT_MS));
    if (error) throw new Error(`查询用户标记失败：${error.message}`, { cause: error });
    const rows = (data ?? []) as UserMark[];
    return new Map(rows.map((row) => [row.mark_key, { ...row, count: Number(row.count) }]));
  }

  async readOne(userId: string, key: UserMarkKey): Promise<UserMark | null> {
    return (await this.read(userId, [key])).get(key) ?? null;
  }

  /** 记一次：count+1，first_at 只写一次，last_at 取最新。at 缺省为数据库时间。 */
  async touch(userId: string, key: UserMarkKey, at?: string): Promise<void> {
    const { error } = await this.features
      .rpc('touch_user_mark', { p_user_id: userId, p_mark_key: key, p_at: at ?? null })
      .abortSignal(AbortSignal.timeout(MARK_TIMEOUT_MS));
    if (error) throw new Error(`记录用户标记失败：${error.message}`, { cause: error });
  }
}
