/**
 * sync-engine / lib / supabase.ts
 *
 * Supabase service_role 客户端单例。
 * service_role 绕过 RLS，同步引擎是唯一持有此 key 的服务端进程（决策 9）。
 *
 * 类型说明：
 *   Supabase JS v2 的 .schema() 方法需要 Database 泛型才能正确推断自定义 schema。
 *   阶段一不生成完整 Database 类型（schema 仍在频繁迭代），
 *   通过 schemaClient() 辅助函数统一处理 schema 切换，内部 as any 封闭类型误报，
 *   调用侧保持干净。
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

let _client: AnyClient | null = null;

export function getSupabaseClient(): AnyClient {
  if (_client) return _client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as AnyClient;
  return _client;
}

/**
 * 返回切换到指定 schema 后的 query builder 起点。
 * 用法：schemaClient('st_platform').from('platform_settings').select(...)
 *
 * 封装原因：createClient 无 Database 泛型时，.schema() 参数类型为 never，
 * 这里统一 as any 处理，调用侧不再需要类型断言。
 */
export function schemaClient(schema: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getSupabaseClient() as any).schema(schema) as AnyClient;
}

export const supabase = new Proxy({} as AnyClient, {
  get(_target, key) {
    return getSupabaseClient()[key as keyof AnyClient];
  },
});
