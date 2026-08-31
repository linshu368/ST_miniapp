/**
 * backend / lib / supabase.ts
 *
 * Supabase service_role 客户端（绕过 RLS）。
 * 专用于 Bridge / 内部服务直接读写 MiniApp 业务表的场景。
 * 普通业务查询仍走 Prisma（DATABASE_URL postgres 用户）。
 *
 * 业务表按归属域分布在多个物理 schema 里（migration 099），所以访问入口是
 * getDomainDb(域名)，而不是一个统一的 .schema('miniapp')。归属权威见
 * docs/schema归属地图.md。
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
 * 八个归属域对应的物理 schema。
 *
 * 前四个由 migration 099 新建；后四个是既有 schema，名称与内部设计不变。
 * 一个 repository 横跨多个域时必须显式取多个域客户端，不要图省事共用一个。
 */
export const DOMAIN_SCHEMAS = [
  'app_core',
  'miniapp_features',
  'experience',
  'billing',
  'admin',
  'cs_platform',
  'miniapp_traffic',
  'miniapp_analytics',
] as const;

export type DomainSchema = (typeof DOMAIN_SCHEMAS)[number];

/**
 * 绑定了某个 schema 的 PostgREST 客户端。
 *
 * 写成 ReturnType<...> 而不是让 TS 推断：底层类型来自 @supabase/postgrest-js，
 * 它不是本包的直接依赖，推断出来的类型没法在 .d.ts 里被命名（TS2742）。
 */
export type DomainDb = ReturnType<SupabaseClient['schema']>;

/**
 * 取绑定到某个归属域的 PostgREST 客户端。
 *
 * 参数写死成域名字面量，是为了让「这段代码在读哪个域」在 review 和 grep 时一眼可见。
 * 目标 schema 必须在 PostgREST 的暴露列表里，否则报 PGRST106；
 * 远程库的暴露列表见 ops/schema-split/postgrest-expose-{test,prod}.sql。
 */
export function getDomainDb(domain: DomainSchema): DomainDb {
  return getSupabaseClient().schema(domain);
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
