import {
  normalizeTelegramAvatarUrl,
  ReplyStylePreferencesSchema,
  type ReplyStylePreferences,
  type StoredPreferredWordCount,
  type UserSettings,
} from '@miniapp/shared';
import { config } from '../../platform/config.js';

export interface MiniappUserSettingsRow {
  user_id: string;
  tg_username: string | null;
  tg_first_name: string | null;
  tg_last_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  tg_avatar_url: string | null;
  custom_avatar_url: string | null;
  /** NULL = 从未选择，跟随 runtime_config 的 default_tier_id（086） */
  pref_word_count: StoredPreferredWordCount;
  pref_show_options: boolean;
  pref_show_status: boolean;
  pref_show_memory: boolean;
  pref_reply_styles: ReplyStylePreferences;
  /** NULL = 从未选择，跟随 drive_mode_options 的默认档 */
  pref_drive_mode: string | null;
  pref_custom_instructions: string | null;
  selected_model_id: string | null;
  pref_voice_id: string | null;
  pref_voice_playback_rate: number;
  created_at: string;
  updated_at: string;
}

export type MutableUserSettingsFields = Partial<
  Pick<
    MiniappUserSettingsRow,
    | 'display_name'
    | 'custom_avatar_url'
    | 'pref_word_count'
    | 'pref_show_options'
    | 'pref_show_status'
    | 'pref_show_memory'
    | 'pref_reply_styles'
    | 'pref_drive_mode'
    | 'pref_custom_instructions'
  >
>;

export type InstructionSlotPreferencePatch = Pick<
  MutableUserSettingsFields,
  'pref_show_options' | 'pref_show_status' | 'pref_show_memory'
>;

export function pickInstructionSlotPreferences(
  update: MutableUserSettingsFields
): InstructionSlotPreferencePatch {
  return {
    ...(update.pref_show_options !== undefined
      ? { pref_show_options: update.pref_show_options }
      : {}),
    ...(update.pref_show_status !== undefined ? { pref_show_status: update.pref_show_status } : {}),
    ...(update.pref_show_memory !== undefined ? { pref_show_memory: update.pref_show_memory } : {}),
  };
}

export function omitInstructionSlotPreferences(
  update: Omit<MutableUserSettingsFields, 'pref_reply_styles'>
): Omit<MutableUserSettingsFields, keyof InstructionSlotPreferencePatch | 'pref_reply_styles'> {
  const {
    pref_show_options: _choice,
    pref_show_status: _status,
    pref_show_memory: _memory,
    ...rest
  } = update;
  return rest;
}

export function toUserSettings(row: MiniappUserSettingsRow): UserSettings {
  const customAvatar = row.custom_avatar_url?.trim();
  const telegramAvatar = normalizeTelegramAvatarUrl(row.tg_avatar_url);
  return {
    display_name: row.display_name,
    avatar_url: customAvatar || telegramAvatar || config.defaultUserAvatarUrl,
    avatar_source: customAvatar ? 'custom' : telegramAvatar ? 'telegram' : 'default',
    pref_word_count: row.pref_word_count,
    pref_show_options: row.pref_show_options ?? true,
    pref_show_status: row.pref_show_status ?? true,
    pref_show_memory: row.pref_show_memory ?? true,
    pref_reply_styles: normalizeReplyStylePreferences(row.pref_reply_styles),
    pref_custom_instructions: row.pref_custom_instructions,
    updated_at: row.updated_at,
  };
}

export function normalizeReplyStylePreferences(value: unknown): ReplyStylePreferences {
  const parsed = ReplyStylePreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function normalizeNullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error('设置字段类型错误');
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}
