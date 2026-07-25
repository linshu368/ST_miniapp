import { getSupabaseClient } from '../../lib/supabase.js';
import {
  normalizeTelegramAvatarUrl,
  type PatchUserSettingsRequest,
  type PreferredWordCount,
  type UserSettings,
} from '@miniapp/shared';
import { config } from '../../platform/config.js';
import type { TelegramUser } from '../../middleware/auth.js';

const WORD_COUNT_OPTIONS: PreferredWordCount[] = ['100-300', '300-500', '500-800', '800+'];

export interface MiniappUserSettingsRow {
  user_id: string;
  tg_username: string | null;
  tg_first_name: string | null;
  tg_last_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  tg_avatar_url: string | null;
  custom_avatar_url: string | null;
  total_round: number;
  pref_word_count: PreferredWordCount;
  pref_show_options: boolean;
  pref_custom_instructions: string | null;
  selected_model_id: string | null;
  created_at: string;
  updated_at: string;
}

export class MiniappUserSettingsRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  async getOrCreate(userId: string, tgUser: TelegramUser): Promise<MiniappUserSettingsRow> {
    const existing = await this.findByUserId(userId);
    if (existing) {
      return await this.refreshTelegramProfile(userId, tgUser);
    }

    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .insert({
        user_id: userId,
        ...this.telegramProfileFields(tgUser),
      })
      .select('*')
      .single();

    if (error) {
      const afterRace = await this.findByUserId(userId);
      if (afterRace) return afterRace;
      throw new Error(`创建 MiniApp 用户设置失败：${error.message}`);
    }

    return data as MiniappUserSettingsRow;
  }

  async patch(
    userId: string,
    tgUser: TelegramUser,
    patch: PatchUserSettingsRequest
  ): Promise<MiniappUserSettingsRow> {
    await this.getOrCreate(userId, tgUser);

    const update = this.normalizePatch(patch);
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .update({
        ...this.telegramProfileFields(tgUser),
        ...update,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw new Error(`更新 MiniApp 用户设置失败：${error.message}`);
    return data as MiniappUserSettingsRow;
  }

  async setCustomAvatar(
    userId: string,
    tgUser: TelegramUser,
    avatarUrl: string
  ): Promise<MiniappUserSettingsRow> {
    await this.getOrCreate(userId, tgUser);
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .update({
        ...this.telegramProfileFields(tgUser),
        custom_avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('*')
      .single();
    if (error) throw new Error(`更新用户头像失败：${error.message}`);
    return data as MiniappUserSettingsRow;
  }

  async setSelectedModelId(
    userId: string,
    tgUser: TelegramUser,
    selectedModelId: string
  ): Promise<MiniappUserSettingsRow> {
    await this.getOrCreate(userId, tgUser);
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .update({
        ...this.telegramProfileFields(tgUser),
        selected_model_id: selectedModelId,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw new Error(`更新模型选择失败：${error.message}`);
    return data as MiniappUserSettingsRow;
  }

  async getSelectedModelId(userId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .select('selected_model_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询用户模型选择失败：${error.message}`);
    return (
      (data as Pick<MiniappUserSettingsRow, 'selected_model_id'> | null)?.selected_model_id ?? null
    );
  }

  private async findByUserId(userId: string): Promise<MiniappUserSettingsRow | null> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询 MiniApp 用户设置失败：${error.message}`);
    return (data as MiniappUserSettingsRow | null) ?? null;
  }

  private async refreshTelegramProfile(
    userId: string,
    tgUser: TelegramUser
  ): Promise<MiniappUserSettingsRow> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .update({
        ...this.telegramProfileFields(tgUser),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw new Error(`刷新 Telegram 用户信息失败：${error.message}`);
    return data as MiniappUserSettingsRow;
  }

  private telegramProfileFields(tgUser: TelegramUser) {
    return {
      tg_username: tgUser.username ?? null,
      tg_first_name: tgUser.first_name ?? null,
      tg_last_name: tgUser.last_name ?? null,
      tg_avatar_url: normalizeTelegramAvatarUrl(tgUser.photo_url),
    };
  }

  private normalizePatch(
    patch: PatchUserSettingsRequest
  ): Partial<
    Pick<
      MiniappUserSettingsRow,
      | 'display_name'
      | 'custom_avatar_url'
      | 'pref_word_count'
      | 'pref_show_options'
      | 'pref_custom_instructions'
    >
  > {
    const update: Partial<
      Pick<
        MiniappUserSettingsRow,
        | 'display_name'
        | 'custom_avatar_url'
        | 'pref_word_count'
        | 'pref_show_options'
        | 'pref_custom_instructions'
      >
    > = {};

    if ('display_name' in patch) {
      update.display_name = normalizeNullableText(patch.display_name, 32);
    }
    if ('avatar_url' in patch) {
      if (patch.avatar_url !== null) {
        throw new Error('自定义头像必须通过头像导入接口设置');
      }
      update.custom_avatar_url = null;
    }
    if ('pref_word_count' in patch) {
      if (!WORD_COUNT_OPTIONS.includes(patch.pref_word_count as PreferredWordCount)) {
        throw new Error('无效的字数偏好');
      }
      update.pref_word_count = patch.pref_word_count;
    }
    if ('pref_show_options' in patch) {
      update.pref_show_options = Boolean(patch.pref_show_options);
    }
    if ('pref_custom_instructions' in patch) {
      update.pref_custom_instructions = normalizeNullableText(patch.pref_custom_instructions, 2000);
    }

    return update;
  }
}

export function toUserSettings(row: MiniappUserSettingsRow): UserSettings {
  const customAvatar = row.custom_avatar_url?.trim();
  const telegramAvatar = normalizeTelegramAvatarUrl(row.tg_avatar_url);
  return {
    display_name: row.display_name,
    avatar_url: customAvatar || telegramAvatar || config.defaultUserAvatarUrl,
    avatar_source: customAvatar ? 'custom' : telegramAvatar ? 'telegram' : 'default',
    pref_word_count: row.pref_word_count,
    pref_show_options: row.pref_show_options,
    pref_custom_instructions: row.pref_custom_instructions,
    updated_at: row.updated_at,
  };
}

function normalizeNullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error('设置字段类型错误');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}
