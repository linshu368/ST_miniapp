// 用户资料（Telegram 资料 + 自定义昵称/头像），存在 app_core.users。
// 见 migration 20261117_db_reorg_p3b2_user_profile.sql。偏好在 app_core.user_preferences。

import { normalizeTelegramAvatarUrl } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import type { TelegramUser } from '../../middleware/auth.js';

export interface UserProfile {
  tg_username: string | null;
  tg_first_name: string | null;
  tg_last_name: string | null;
  tg_avatar_url: string | null;
  display_name: string | null;
  custom_avatar_url: string | null;
  updated_at: string;
}

export type UserProfileNames = Pick<UserProfile, 'display_name' | 'tg_first_name' | 'tg_username'>;
export type EditableUserProfile = Partial<Pick<UserProfile, 'display_name' | 'custom_avatar_url'>>;

const PROFILE_COLUMNS =
  'tg_username, tg_first_name, tg_last_name, tg_avatar_url, display_name, custom_avatar_url, updated_at';
const PROFILE_TIMEOUT_MS = 5_000;

export class UserProfileRepository {
  private get db() {
    return getDomainDb('app_core');
  }

  /** 按 initData 刷新 TG 资料并返回当前资料；值没变时数据库不写。 */
  async refreshTelegram(userId: string, tgUser: TelegramUser): Promise<UserProfile> {
    const { data, error } = await this.db
      .rpc('refresh_user_profile', {
        p_user_id: userId,
        p_tg_username: tgUser.username ?? null,
        p_tg_first_name: tgUser.first_name ?? null,
        p_tg_last_name: tgUser.last_name ?? null,
        p_tg_avatar_url: normalizeTelegramAvatarUrl(tgUser.photo_url),
      })
      .abortSignal(AbortSignal.timeout(PROFILE_TIMEOUT_MS));
    if (error) throw new Error(`刷新 Telegram 用户信息失败：${error.message}`, { cause: error });
    if (!data) throw new Error('刷新 Telegram 用户信息失败：用户不存在');
    return data as UserProfile;
  }

  async read(userId: string): Promise<UserProfile | null> {
    const { data, error } = await this.db
      .from('users')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .abortSignal(AbortSignal.timeout(PROFILE_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(`查询用户资料失败：${error.message}`, { cause: error });
    return (data as UserProfile | null) ?? null;
  }

  async readNames(userId: string): Promise<UserProfileNames | null> {
    const { data, error } = await this.db
      .from('users')
      .select('display_name, tg_first_name, tg_username')
      .eq('id', userId)
      .abortSignal(AbortSignal.timeout(PROFILE_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(`查询用户昵称失败：${error.message}`, { cause: error });
    return (data as UserProfileNames | null) ?? null;
  }

  async update(userId: string, fields: EditableUserProfile): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    const { error } = await this.db
      .from('users')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .abortSignal(AbortSignal.timeout(PROFILE_TIMEOUT_MS));
    if (error) throw new Error(`更新用户资料失败：${error.message}`, { cause: error });
  }
}
