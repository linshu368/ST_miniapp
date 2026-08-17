import type { Database } from './generated.js';

// st_platform
export type PlatformApiConfigRow = Database['st_platform']['Tables']['platform_api_configs']['Row'];
export type PlatformPresetRow = Database['st_platform']['Tables']['platform_presets']['Row'];
export type PlatformSettingsRow = Database['st_platform']['Tables']['platform_settings']['Row'];

// st_users
export type UserStSettingsRow = Database['st_users']['Tables']['user_st_settings']['Row'];
export type UserStChatRow = Database['st_users']['Tables']['user_st_chats']['Row'];

// st_infra
export type SyncTaskRow = Database['st_infra']['Tables']['sync_tasks']['Row'];
