/**
 * backend / lib / supabase.ts
 *
 * Supabase service_role 客户端（绕过 RLS）。
 * 专用于 Bridge / 内部服务直接读写 miniapp.users 和 MiniApp 业务表的场景。
 * 普通业务查询仍走 Prisma（DATABASE_URL postgres 用户）。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from '../platform/config.js';

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const url = config.supabase.url;
  const key = config.supabase.serviceRoleKey;

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
    realtime: {
      transport: WebSocket as never,
    },
  });

  return _client;
}

/**
 * 释放脚本进程可能创建的 Realtime 连接。
 *
 * 业务查询走 Supabase REST，本身没有可显式关闭的数据库连接池；removeAllChannels()
 * 是 supabase-js 提供的客户端级清理入口。清理后丢弃单例，避免一次性任务残留句柄。
 */
export async function closeSupabaseClient(): Promise<void> {
  if (!_client) return;
  await _client.removeAllChannels();
  _client = null;
}
