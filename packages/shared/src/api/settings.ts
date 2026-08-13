// MiniApp 用户设置领域的前后端共享契约

/**
 * 回复长度档位 id。权威列表来自 runtime_config.pref_word_count_tiers，
 * 不再是固定四值枚举；非法或已下线的 id 在读取/渲染时回落到 default_tier_id。
 */
export type PreferredWordCount = string;
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
  pref_word_count: PreferredWordCount;
  pref_show_options: boolean;
  pref_custom_instructions: string | null;
  updated_at: string;
}

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
  pref_custom_instructions?: string | null;
}

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
