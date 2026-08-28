import { getDomainDb } from './supabase.js';
import { deriveStHandle } from '@miniapp/shared';
import type { TelegramUser } from '../middleware/auth.js';

export interface MiniappDbUser {
  id: string;
  tg_id: string;
  source_id: string | null;
  bot_entered_at: string | null;
  miniapp_entered_at: string | null;
  total_round: number;
  st_handle: string;
  st_initialized_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 确保 app_core.users 中有对应的 MiniApp 用户记录并返回。
 * 不再写 public.users，MiniApp 身份从这里开始独立。
 */
export async function getOrCreateDbUser(tgUser: TelegramUser): Promise<MiniappDbUser> {
  const tgIdStr = tgUser.id.toString();
  return getOrCreateMiniappUserByTgId(tgIdStr, null, true);
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

  const stHandle = deriveStHandle(tgId);
  const now = new Date().toISOString();
  const { data, error: insertErr } = await db
    .from('users')
    .insert({
      tg_id: tgId,
      source_id: sourceId,
      st_handle: stHandle,
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
