import { getDomainDb } from './supabase.js';
import type { TelegramUser } from '../middleware/auth.js';
import { bindBusinessContext } from '../platform/observability/context.js';

/**
 * 几乎每个已登录接口都先走这里，PostgREST 挂死时它曾拖到约 300s（Sentry GET users p50 58s）。
 * 建用户/读用户的 RPC 加 5s 上限：失败直接抛错，路由返回 5xx，前端可以重试。
 * 客户端放弃时服务端可能已经提交，但 RPC 幂等（tg_id 唯一、入口时间只补空值），重试不会产生重复用户。
 */
const USER_READ_TIMEOUT_MS = 5_000;
/**
 * 页面会同时请求钱包、VIP、设置、通知等接口，它们都只需要稳定的内部用户身份。
 * 缓存只暴露不可变字段，避免把 source_id / total_round 等业务状态带进跨请求缓存。
 */
const USER_IDENTITY_CACHE_TTL_MS = 60_000;
export const USER_IDENTITY_CACHE_MAX_ENTRIES = 5_000;

export interface MiniappDbUser {
  id: string;
  tg_id: string;
  source_id: string | null;
  bot_entered_at: string | null;
  miniapp_entered_at: string | null;
  total_round: number;
  created_at: string;
  updated_at: string;
}

export interface MiniappDbUserIdentity {
  readonly id: string;
  readonly created_at: string;
}

interface CachedUserIdentity {
  value: MiniappDbUserIdentity;
  expiresAt: number;
}

const identityCache = new Map<string, CachedUserIdentity>();
const identityInflight = new Map<string, Promise<MiniappDbUserIdentity>>();

/**
 * 确保 app_core.users 中有对应的 MiniApp 用户记录并返回。
 */
export async function getOrCreateDbUser(tgUser: TelegramUser): Promise<MiniappDbUserIdentity> {
  // Bind in each caller, including cache hits and waiters sharing another request's Promise.
  const user = await loadDbUserIdentity(tgUser);
  bindBusinessContext({ user_id: user.id });
  return user;
}

async function loadDbUserIdentity(tgUser: TelegramUser): Promise<MiniappDbUserIdentity> {
  const tgIdStr = tgUser.id.toString();
  const now = Date.now();
  const cached = identityCache.get(tgIdStr);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) identityCache.delete(tgIdStr);

  const running = identityInflight.get(tgIdStr);
  if (running) return running;

  const promise = resolveDbUserIdentity(tgIdStr);
  identityInflight.set(tgIdStr, promise);
  void promise.then(
    () => clearIdentityInflight(tgIdStr, promise),
    () => clearIdentityInflight(tgIdStr, promise)
  );
  return promise;
}

/** 需要 source_id / total_round 等可变字段的少数调用方必须显式走完整行读取。 */
export async function getOrCreateDbUserRecord(tgUser: TelegramUser): Promise<MiniappDbUser> {
  const user = await getOrCreateMiniappUserByTgId(tgUser.id.toString(), null, true);
  bindBusinessContext({ user_id: user.id });
  return user;
}

/** 测试与显式恢复入口；正常业务无需主动清理，TTL 会自动失效。 */
export function clearDbUserIdentityCache(): void {
  identityCache.clear();
  identityInflight.clear();
}

async function resolveDbUserIdentity(tgId: string): Promise<MiniappDbUserIdentity> {
  const user = await getOrCreateMiniappUserByTgId(tgId, null, true);
  const identity = { id: user.id, created_at: user.created_at };
  cacheUserIdentity(tgId, identity);
  return identity;
}

function clearIdentityInflight(tgId: string, promise: Promise<MiniappDbUserIdentity>): void {
  if (identityInflight.get(tgId) === promise) identityInflight.delete(tgId);
}

function cacheUserIdentity(tgId: string, identity: MiniappDbUserIdentity): void {
  const now = Date.now();
  if (identityCache.size >= USER_IDENTITY_CACHE_MAX_ENTRIES) {
    for (const [key, entry] of identityCache) {
      if (entry.expiresAt <= now) identityCache.delete(key);
    }
  }
  while (identityCache.size >= USER_IDENTITY_CACHE_MAX_ENTRIES) {
    const oldestKey = identityCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    identityCache.delete(oldestKey);
  }
  identityCache.set(tgId, {
    value: identity,
    expiresAt: now + USER_IDENTITY_CACHE_TTL_MS,
  });
}

/** 注册时间：畅聊新人试用从这里算。生成链路只有 user UUID，所以单独按主键读。 */
export async function findUserCreatedAt(userId: string): Promise<string | null> {
  const { data, error } = await getDomainDb('app_core')
    .from('users')
    .select('created_at')
    .eq('id', userId)
    .abortSignal(AbortSignal.timeout(USER_READ_TIMEOUT_MS))
    .maybeSingle();
  if (error) {
    throw new Error(`查询 MiniApp 用户注册时间失败：${error.message}`, { cause: error });
  }
  const createdAt = (data as { created_at?: unknown } | null)?.created_at;
  return typeof createdAt === 'string' ? createdAt : null;
}

/** 支付 webhook/cron 没有 Telegram header，用内部 user UUID 反查 analytics identity。 */
export async function findTelegramIdByUserId(userId: string): Promise<string | null> {
  const { data, error } = await getDomainDb('app_core')
    .from('users')
    .select('tg_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`查询 MiniApp 用户 Telegram ID 失败：${error.message}`, { cause: error });
  }

  const tgId = data?.tg_id;
  return typeof tgId === 'string' && tgId.length > 0 ? tgId : null;
}

/**
 * 建用户 + 写归因走一次 RPC（miniapp_traffic.enter_user）：身份在 app_core.users，来源与入口时间在
 * miniapp_traffic.user_attributions，轮数在 experience.user_chat_stats。函数里首次建号记来源、
 * 入口时间只补空值，没有要补的值时只读不写；返回形状与原 users 行一致。
 * 重复调用幂等（tg_id 唯一、只补空值），超时后客户端重试是安全的。
 */
async function enterUser(
  tgId: string,
  sourceId: string | null,
  entry: 'miniapp' | 'bot' | null
): Promise<MiniappDbUser> {
  const { data, error } = await getDomainDb('miniapp_traffic')
    .rpc('enter_user', { p_tg_id: tgId, p_source_id: sourceId, p_entry: entry })
    .abortSignal(AbortSignal.timeout(USER_READ_TIMEOUT_MS));
  if (error) {
    throw new Error(`查询 MiniApp 用户失败：${error.message}`, { cause: error });
  }
  const row = data as
    | (Omit<MiniappDbUser, 'total_round'> & { total_round: number | string })
    | null;
  if (!row?.id) throw new Error('查询 MiniApp 用户失败：返回为空');
  return { ...row, total_round: Number(row.total_round) || 0 };
}

export async function getOrCreateMiniappUserByTgId(
  tgId: string,
  sourceId: string | null = null,
  markMiniappEntered = true
): Promise<MiniappDbUser> {
  return enterUser(tgId, sourceId, markMiniappEntered ? 'miniapp' : null);
}

export async function recordBotStart(
  tgId: string,
  sourceId: string | null = null
): Promise<MiniappDbUser> {
  return enterUser(tgId, sourceId, 'bot');
}
