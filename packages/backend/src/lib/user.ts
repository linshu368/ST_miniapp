import { prisma } from './db.js';
import { getSupabaseClient } from './supabase.js';
import { deriveStHandle } from '@miniapp/shared';
import type { TelegramUser } from '../middleware/auth.js';

/**
 * 确保数据库中有对应的 User 记录并返回。
 * 同时负责写入 st_handle（通过 Supabase service_role）。
 *
 * 职责拆分：
 *   - Prisma upsert：维护 public.users 的基础行（tg_id）
 *   - Supabase client：写入 st_handle（D002 决策：走 service_role，不经 Prisma）
 */
export async function getOrCreateDbUser(tgUser: TelegramUser) {
  const tgIdStr = tgUser.id.toString();

  // 1. Prisma upsert 确保行存在
  const user = await prisma.user.upsert({
    where: { tg_id: tgIdStr },
    update: {},
    create: {
      tg_id: tgIdStr,
    },
  });

  // 2. 确保 st_handle 已写入（幂等：只在 NULL 时写）
  await ensureStHandle(user.id, tgIdStr);

  return user;
}

/**
 * 确保 users.st_handle 已填写。
 * 幂等：若已有值则跳过，避免覆盖已派生的 handle。
 */
async function ensureStHandle(userId: string, tgId: string): Promise<void> {
  const db = getSupabaseClient();
  const stHandle = deriveStHandle(tgId);

  // 先查是否已有 st_handle
  const { data, error: readErr } = await db
    .from('users')
    .select('st_handle')
    .eq('id', userId)
    .single();

  if (readErr) {
    // 非致命：记录警告，不阻断主流程
    console.warn(`[user] 查询 st_handle 失败（userId=${userId}）：${readErr.message}`);
    return;
  }

  if (data?.st_handle) {
    // 已有，跳过
    return;
  }

  // 写入 st_handle
  const { error: writeErr } = await db
    .from('users')
    .update({ st_handle: stHandle })
    .eq('id', userId);

  if (writeErr) {
    console.warn(`[user] 写入 st_handle 失败（userId=${userId}）：${writeErr.message}`);
  }
}
