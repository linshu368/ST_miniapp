// MiniApp 用户设置领域的前后端共享契约

export type PreferredWordCount = '100-300' | '300-500' | '500-800' | '800+';

export interface UserSettings {
  display_name: string | null;
  avatar_url: string | null;
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
