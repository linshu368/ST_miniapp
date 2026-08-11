/**
 * backend / scripts / mvp-regression / fixtures.ts
 *
 * M3b 回归的测试数据。钱包 / 免费额度 / chat_history / 扣费明细这些与 ST 回归共用的读写
 * 直接从 st-regression/fixtures.ts 引，只在这里补会话与消息两张新表的部分。
 *
 * 依赖方向是单向的：st-regression 不引本文件——它要能在批次 1 之前的 commit 上原样跑，
 * 见 st-regression/run.ts 头部的对拍步骤。
 *
 * 用户的 tg_id 必须是**数字串**：requireTelegramAuth 拿到的是 Telegram 的数字 id，
 * getOrCreateDbUser 用它回查 miniapp.users。所以遗留数据的清理靠 st_handle 前缀认领。
 */

import { getSupabaseClient } from '../../lib/supabase.js';
import type { ChatMessageRow } from '../../infrastructure/repositories/ChatMessageRepository.js';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';

export {
  cleanupRunArtifacts,
  getFreeQuotaUsedRounds,
  getWalletCredits,
  listChatHistory,
  listUsageCharges,
  pickCatalogModels,
  seedFreeModelIntoCatalog,
  setFreeQuotaUsedRounds,
  setSelectedModel,
  setWalletBalance,
  waitForChatHistory,
  type CatalogModelPick,
  type ChatHistoryRow,
  type UsageChargeRow,
} from '../st-regression/fixtures.js';

const HANDLE_PREFIX = 'mvp_regr_';
const CARD_HASH_PREFIX = 'mvp-regr-';

/** 8_8xx_xxx_xxx 段不与真实 Telegram id 冲突，且一眼能认出是本脚本造的 */
const TG_ID_BASE = 8_800_000_000;

export const OPENING_MESSAGE = '（MVP 回归测试开场白）你抬头看了看天。';
export const CHARACTER_SYSTEM_PROMPT = '你是一个用于 M3b 回归测试的角色。永远用中文回答。';

export interface ConversationFixtures {
  userId: string;
  tgId: string;
  characterId: string;
  tag: string;
}

function db() {
  return getSupabaseClient().schema('miniapp');
}

export async function seedConversationFixtures(): Promise<ConversationFixtures> {
  const tag = Date.now().toString(36);
  const tgId = String(TG_ID_BASE + Math.floor(Math.random() * 1_000_000));

  const { data: user, error: userError } = await db()
    .from('users')
    .insert({ tg_id: tgId, st_handle: `${HANDLE_PREFIX}${tag}` })
    .select('id')
    .single();
  if (userError) throw new Error(`创建测试用户失败：${userError.message}`);

  const { data: character, error: characterError } = await db()
    .from('characters')
    .insert({
      name: `MVP 回归测试角色 ${tag}`,
      first_mes: OPENING_MESSAGE,
      system_prompt: CHARACTER_SYSTEM_PROMPT,
      // 062 的 characters_test_cards_disabled 要求测试卡必须 enabled=false 且带 card_hash
      enabled: false,
      is_test: true,
      card_hash: `${CARD_HASH_PREFIX}${tag}`,
    })
    .select('id')
    .single();
  if (characterError) throw new Error(`创建测试角色卡失败：${characterError.message}`);

  return {
    userId: (user as { id: string }).id,
    tgId,
    characterId: (character as { id: string }).id,
    tag,
  };
}

export async function listSessionRows(userId: string): Promise<ChatSessionRow[]> {
  const { data, error } = await db()
    .from('chat_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`查询 chat_sessions 失败：${error.message}`);
  return (data ?? []) as ChatSessionRow[];
}

export async function getSessionRow(sessionId: string): Promise<ChatSessionRow | null> {
  const { data, error } = await db()
    .from('chat_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw new Error(`查询会话失败：${error.message}`);
  return (data as ChatSessionRow | null) ?? null;
}

/** 含非生效版本：重生成那条判据要确认旧版本确实留了档 */
export async function listMessageRows(sessionId: string): Promise<ChatMessageRow[]> {
  const { data, error } = await db()
    .from('chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('turn_index', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`查询 chat_messages 失败：${error.message}`);
  return (data ?? []) as ChatMessageRow[];
}

/**
 * 落库是在 SSE 收流之后才发生的，HTTP 响应结束时那条 UPDATE 往往还在飞。
 * 轮询到该消息离开 streaming 为止，而不是 sleep 一个拍脑袋的固定值。
 */
export async function waitForSettledMessage(
  messageId: string,
  timeoutMs = 20_000
): Promise<ChatMessageRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data, error } = await db()
      .from('chat_messages')
      .select('*')
      .eq('id', messageId)
      .maybeSingle();
    if (error) throw new Error(`查询消息失败：${error.message}`);

    const row = data as ChatMessageRow | null;
    if (row && row.status !== 'streaming') return row;
    if (Date.now() >= deadline) {
      throw new Error(`等待消息收口超时：${messageId} 仍为 ${row?.status ?? 'missing'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 清掉上一个场景留下的会话与落库痕迹，让各场景的条数断言可以用绝对值 */
export async function resetConversationArtifacts(userId: string): Promise<void> {
  await db().from('chat_history').delete().eq('user_id', userId);
  await db().from('llm_usage_charges').delete().eq('user_id', userId);
  await db().from('character_free_chat_quota_decisions').delete().eq('user_id', userId);
  // chat_messages 由 chat_sessions 的 ON DELETE CASCADE 带走
  await db().from('chat_sessions').delete().eq('user_id', userId);
}

export async function cleanupConversationFixtures(fixtures: ConversationFixtures): Promise<void> {
  await resetConversationArtifacts(fixtures.userId);
  await db().from('character_free_chat_quotas').delete().eq('user_id', fixtures.userId);
  await db().from('user_wallets').delete().eq('user_id', fixtures.userId);
  await db().from('miniapp_user_settings').delete().eq('user_id', fixtures.userId);
  await db().from('users').delete().eq('id', fixtures.userId);
  // 会话必须先删干净：chat_sessions → characters 是 ON DELETE RESTRICT
  await db().from('characters').delete().eq('id', fixtures.characterId);
}

/** 上次异常退出遗留的数据。开跑前扫一遍，比指望每次都优雅退出可靠。 */
export async function sweepOrphanFixtures(): Promise<number> {
  const { data, error } = await db()
    .from('users')
    .select('id')
    .like('st_handle', `${HANDLE_PREFIX}%`);
  if (error) throw new Error(`扫描遗留测试用户失败：${error.message}`);

  const userIds = (data ?? []).map((row) => (row as { id: string }).id);
  for (const userId of userIds) {
    await resetConversationArtifacts(userId);
    await db().from('character_free_chat_quotas').delete().eq('user_id', userId);
    await db().from('user_wallets').delete().eq('user_id', userId);
    await db().from('miniapp_user_settings').delete().eq('user_id', userId);
    await db().from('users').delete().eq('id', userId);
  }
  await db().from('characters').delete().like('card_hash', `${CARD_HASH_PREFIX}%`);
  return userIds.length;
}
