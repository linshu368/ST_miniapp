// AUTO-GENERATED — DO NOT EDIT
// Run `pnpm db:gen` to regenerate
// Placeholder — first real generation pending Supabase CLI setup

export interface Database {
  st_platform: {
    Tables: {
      platform_presets: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      platform_settings: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
    };
  };
  st_users: {
    Tables: {
      user_st_settings: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
      user_st_chats: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
    };
  };
  st_infra: {
    Tables: {
      sync_tasks: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
    };
  };
}
