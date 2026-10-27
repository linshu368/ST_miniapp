import { getDomainDb } from './supabase.js';
import type { TelegramUser } from '../middleware/auth.js';

/**
 * 几乎每个已登录接口都先走这里，PostgREST 挂死时它曾拖到约 300s（Sentry GET users p50 58s）。
 * 这里只给按 tg_id 的读加 5s 上限：读失败直接抛错，路由返回 5xx，前端可以重试。
 * 插入/更新只受全局 30s 兜底约束：客户端放弃时服务端可能已经提交，
 * 但下次请求会按 tg_id 回读到这条记录（tg_id 唯一），所以重试不会产生重复用户。
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
 * 不再写 public.users，MiniApp 身份从这里开始独立。
 */
export async function getOrCreateDbUser(tgUser: TelegramUser): Promise<MiniappDbUserIdentity> {
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
export function getOrCreateDbUserRecord(tgUser: TelegramUser): Promise<MiniappDbUser> {
  return getOrCreateMiniappUserByTgId(tgUser.id.toString(), null, true);
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

/** 支付 webhook/cron 没有 Telegram header，用内部 user UUID 反查 analytics identity。 */
export async function findTelegramIdByUserId(userId: string): Promise<string | null> {
  const { data, error } = await getDomainDb('app_core')
    .from('users')
    .select('tg_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`查询 MiniApp 用户 Telegram ID 失败：${error.message}`);
  }

  const tgId = data?.tg_id;
  return typeof tgId === 'string' && tgId.length > 0 ? tgId : null;
}

export async function getOrCreateMiniappUserByTgId(
  tgId: string,
  sourceId: string | null = null,
  markMiniappEntered = true
): Promise<MiniappDbUser> {
  const db = getDomainDb('app_core');

  const { data: existing, error: readErr } = await db
    .from('users')
    .select('*')
    .eq('tg_id', tgId)
    .abortSignal(AbortSignal.timeout(USER_READ_TIMEOUT_MS))
    .maybeSingle();

  if (readErr) {
    throw new Error(`查询 MiniApp 用户失败：${readErr.message}`);
  }

  if (existing) {
    const user = existing as MiniappDbUser;
    if (markMiniappEntered && !user.miniapp_entered_at) {
      return markMiniappEnteredAt(user.id);
    }
    return user;
  }

  const now = new Date().toISOString();
  const { data, error: insertErr } = await db
    .from('users')
    .insert({
      tg_id: tgId,
      source_id: sourceId,
      miniapp_entered_at: markMiniappEntered ? now : null,
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();

  if (!insertErr && data) {
    return data as MiniappDbUser;
  }

  // 并发首次登录时可能已有另一个请求完成插入，回读一次保证幂等。
  const { data: afterRace, error: raceReadErr } = await db
    .from('users')
    .select('*')
    .eq('tg_id', tgId)
    .abortSignal(AbortSignal.timeout(USER_READ_TIMEOUT_MS))
    .maybeSingle();

  if (raceReadErr) {
    throw new Error(`创建 MiniApp 用户失败，且回读失败：${raceReadErr.message}`);
  }
  if (afterRace) {
    const user = afterRace as MiniappDbUser;
    if (markMiniappEntered && !user.miniapp_entered_at) {
      return markMiniappEnteredAt(user.id);
    }
    return user;
  }

  throw new Error(`创建 MiniApp 用户失败：${insertErr?.message ?? 'unknown error'}`);
}

export async function recordBotStart(
  tgId: string,
  sourceId: string | null = null
): Promise<MiniappDbUser> {
  const user = await getOrCreateMiniappUserByTgId(tgId, sourceId, false);
  if (user.bot_entered_at) return user;

  const now = new Date().toISOString();
  const { data, error } = await getDomainDb('app_core')
    .from('users')
    .update({
      bot_entered_at: now,
      source_id: user.source_id ?? sourceId,
      updated_at: now,
    })
    .eq('id', user.id)
    .is('bot_entered_at', null)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`记录 bot /start 时间失败：${error.message}`);
  }

  return (data as MiniappDbUser | null) ?? user;
}

async function markMiniappEnteredAt(userId: string): Promise<MiniappDbUser> {
  const now = new Date().toISOString();
  const { data, error } = await getDomainDb('app_core')
    .from('users')
    .update({
      miniapp_entered_at: now,
      updated_at: now,
    })
    .eq('id', userId)
    .is('miniapp_entered_at', null)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`记录 MiniApp 首次进入时间失败：${error.message}`);
  }

  if (data) return data as MiniappDbUser;

  const { data: current, error: readErr } = await getDomainDb('app_core')
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (readErr || !current) {
    throw new Error(`记录 MiniApp 首次进入时间后回读失败：${readErr?.message ?? 'not found'}`);
  }

  return current as MiniappDbUser;
}
