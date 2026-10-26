// MiniApp 用户设置领域的前后端共享契约
import { z } from 'zod';
import { ReplyStylePreferencesSchema, type ReplyStylePreferences } from './reply-style-options';

/**
 * 回复长度档位 id。权威列表来自 runtime_config.pref_word_count_tiers，
 * 不再是固定四值枚举；非法或已下线的 id 在读取/渲染时回落到 default_tier_id。
 */
export type PreferredWordCount = string;

/**
 * 用户存档的档位 id，null 表示从未选择、跟随当前 default_tier_id。
 * 生成链路拿到的 UserGenerationConfig.pref_word_count 已经解析过，永远是具体档位。
 */
export type StoredPreferredWordCount = PreferredWordCount | null;
export type AvatarSource = 'custom' | 'telegram' | 'default';

/**
 * 平台默认头像的测试环境地址。
 * 各环境的 Supabase 项目不同，生产必须通过环境变量覆盖，见 resolveDefaultUserAvatarUrl。
 */
export const DEFAULT_USER_AVATAR_URL =
  'https://zoqelpfhurwehlvypryl.supabase.co/storage/v1/object/public/miniapp-user-avatars/default_user_avatar/default-user-avatar-20260713.png';

/**
 * 解析平台默认头像地址。各端把自己的环境变量传进来，空值回退到测试环境地址。
 * 读取环境变量的动作留在各端：前端必须写成字面量 process.env.NEXT_PUBLIC_* 才能在
 * 构建期被内联，共享包内的动态访问在浏览器里取不到值。
 */
export function resolveDefaultUserAvatarUrl(override: string | null | undefined): string {
  return override?.trim() || DEFAULT_USER_AVATAR_URL;
}

export interface UserSettings {
  display_name: string | null;
  /** Effective avatar URL after custom > Telegram > platform-default resolution. */
  avatar_url: string;
  avatar_source: AvatarSource;
  pref_word_count: StoredPreferredWordCount;
  pref_show_options: boolean;
  pref_show_status: boolean;
  pref_show_memory: boolean;
  /** Missing means no selected styles; independent boolean choices. */
  pref_reply_styles?: ReplyStylePreferences;
  pref_custom_instructions: string | null;
  updated_at: string;
}

/** 浏览器可见的用户设置；不包含数据库内部的规则窗口计数。 */
export const UserSettingsSchema: z.ZodType<UserSettings> = z
  .object({
    display_name: z.string().nullable(),
    avatar_url: z.string(),
    avatar_source: z.enum(['custom', 'telegram', 'default']),
    pref_word_count: z.string().nullable(),
    pref_show_options: z.boolean(),
    pref_show_status: z.boolean(),
    pref_show_memory: z.boolean(),
    pref_reply_styles: ReplyStylePreferencesSchema.optional(),
    pref_custom_instructions: z.string().nullable(),
    updated_at: z.string(),
  })
  .strict();

// ==== GET /api/users/settings ====
export interface GetUserSettingsData {
  settings: UserSettings;
}

// ==== PATCH /api/users/settings ====
export interface PatchUserSettingsRequest {
  display_name?: string | null;
  avatar_url?: string | null;
  pref_word_count?: PreferredWordCount;
  pref_show_options?: boolean;
  pref_show_status?: boolean;
  pref_show_memory?: boolean;
  /** Partial map merge; unrelated option IDs are preserved. */
  pref_reply_styles?: ReplyStylePreferences;
  pref_custom_instructions?: string | null;
}

/** PATCH 只接受显式的用户可编辑字段，未知字段不能静默写入。 */
export const PatchUserSettingsRequestSchema: z.ZodType<PatchUserSettingsRequest> = z
  .object({
    display_name: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    pref_word_count: z.string().optional(),
    pref_show_options: z.boolean().optional(),
    pref_show_status: z.boolean().optional(),
    pref_show_memory: z.boolean().optional(),
    pref_reply_styles: ReplyStylePreferencesSchema.optional(),
    pref_custom_instructions: z.string().nullable().optional(),
  })
  .strict();

export interface PatchUserSettingsData {
  settings: UserSettings;
}

// ==== POST /api/users/avatar ====
export type SetUserAvatarRequest =
  | { source: 'upload'; content_type: string; data_base64: string }
  | { source: 'url'; url: string };

export interface SetUserAvatarData {
  settings: UserSettings;
}
