/**
 * backend / lib / supabase.ts
 *
 * Supabase service_role 客户端（绕过 RLS）。
 * 专用于 Bridge 侧需要直接读写 st_handle / st_initialized_at 的场景。
 * 普通业务查询仍走 Prisma（DATABASE_URL postgres 用户）。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 未配置，Bridge 无法初始化 Supabase 客户端'
    );
  }

  _client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}
