import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, classifyError } from './errors';
import { FileSessionStorage, loadConfig, withSessionLock, type CliConfig } from './store';

/** CLI 只连生产；草稿、发布记录的 environment 字段固定为它。 */
export const CLI_ENVIRONMENT = 'production' as const;

const STORAGE_KEY = 'mijing-admin-cli-production';
const REQUEST_TIMEOUT_MS = 15_000;
const READ_RETRY_DELAYS_MS = [350, 1_000];

/** 每个请求都有超时；调用方自己传了 signal 时两者任一触发即中止。 */
const timeoutFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};

/**
 * 与网页一样经后端 `/api/admin/supabase` 代理访问 Supabase：同一放行规则、同一后端日志。
 * 不开 autoRefreshToken（CLI 不常驻）；需要刷新时由 getSession 在会话锁内完成。
 */
export function createAdminSupabaseClient(config: CliConfig): SupabaseClient {
  return createClient(`${config.apiUrl}/api/admin/supabase`, config.anonKey, {
    auth: {
      storage: new FileSessionStorage(),
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: timeoutFetch },
  });
}

export interface AuthedClient {
  client: SupabaseClient;
  config: CliConfig;
  accessToken: string;
  userId: string;
}

export async function getAuthedClient(): Promise<AuthedClient> {
  const config = loadConfig();
  const client = createAdminSupabaseClient(config);
  const { data, error } = await withSessionLock(() => client.auth.getSession());
  if (error) throw classifyError(error);
  const session = data.session;
  if (!session) {
    throw new CliError('auth_required', '未登录或登录已过期。请本人在终端执行：pnpm admin login');
  }
  return { client, config, accessToken: session.access_token, userId: session.user.id };
}

/**
 * 只读操作在网络错误/服务暂不可用时有限重试；写操作绝不经过这里，
 * 结果未知时由使用者先读状态再决定，避免重复写入。
 */
export async function withReadRetry<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (classifyError(error).code !== 'unavailable') throw error;
      const delay = READ_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  throw lastError;
}
