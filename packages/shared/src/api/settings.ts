// MiniApp 用户设置领域的前后端共享契约

export type PreferredWordCount = '100-300' | '300-500' | '500-800' | '800+';
export type AvatarSource = 'custom' | 'telegram' | 'default';

export const DEFAULT_USER_AVATAR_URL =
  'https://zoqelpfhurwehlvypryl.supabase.co/storage/v1/object/public/miniapp-users/default_user_avatar/4d015fdd-7f82-482c-912d-466eaa826280.png';

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
