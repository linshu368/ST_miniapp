/**
 * backend / scripts / mvp-regression / fixtures.ts
 *
 * M3b 回归的测试数据：钱包 / 免费额度 / chat_history / 扣费明细，以及会话与对话轮次。
 *
 * 用户的 tg_id 必须是**数字串**：requireTelegramAuth 拿到的是 Telegram 的数字 id，
 * getOrCreateDbUser 用它回查 miniapp.users。所以遗留数据的清理靠 st_handle 前缀认领。
 */

import { getSupabaseClient } from '../../lib/supabase.js';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';

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
  characterName: string;
  tag: string;
}

function db() {
  return getSupabaseClient().schema('miniapp');
}

export interface CatalogModelPick {
  /** 目录 stable id，写进 miniapp_user_settings.selected_model_id */
  modelId: string;
  openRouterModelId: string;
  markup: number;
  deductMarkup: number | null;
}

/**
 * 从目录里各挑一个免费模型（markup = 0）和一个付费模型（markup > 0）。
 * 不写死模型 id：目录是 runtime_config 里的 JSONB 文档，运营随时会改。
 */
export async function pickCatalogModels(): Promise<{
  free: CatalogModelPick | null;
  paid: CatalogModelPick | null;
}> {
  const { catalog } = await fetchModelCatalogSnapshot();
  const models = catalog.tiers
    .flatMap((tier) => tier.models)
    .filter((model) => model.enabled)
    .map(
      (model): CatalogModelPick => ({
        modelId: model.id,
        openRouterModelId: model.openrouter_model_id,
        markup: model.markup,
        deductMarkup: model.deduct_markup ?? null,
      })
    );

  return {
    free: models.find((model) => model.markup === 0) ?? null,
    paid: models.find((model) => model.markup > 0) ?? null,
  };
}

export interface CatalogOverride {
  freeModel: CatalogModelPick;
  restore(): Promise<void>;
}

/**
 * 往模型目录里临时插一个免费模型（markup = 0）。
 *
 * test 库的目录里现在一个免费模型都没有，免费额度那条判据因此永远跑不到。这里直接改
 * miniapp.runtime_config 的 llm_model_catalog，跑完还原。
 *
 * ⚠️ 这是**共享配置**，改的瞬间同一个 test 库上的其他人也会看到。所以它藏在
 *    --seed-free-model 后面，默认不开；调用方必须保证 restore() 一定会执行。
 */
export async function seedFreeModelIntoCatalog(): Promise<CatalogOverride> {
  const { data, error } = await db()
    .from('runtime_config')
    .select('value, version')
    .eq('key', 'llm_model_catalog')
    .maybeSingle();
  if (error) throw new Error(`读取 llm_model_catalog 失败：${error.message}`);

  const entry = data as { value: unknown; version: number } | null;
  if (!entry || !entry.value || typeof entry.value !== 'object') {
    throw new Error('llm_model_catalog 不存在或不是对象，无法注入免费模型');
  }

  const original = entry.value as { tiers: Array<{ models: unknown[] }> };
  const freeModel: CatalogModelPick = {
    modelId: 'mvp-regression-free',
    openRouterModelId: 'mvp-regression/free-model',
    markup: 0,
    deductMarkup: 2,
  };

  const cleanOriginal = JSON.parse(JSON.stringify(original)) as {
    tiers: Array<{
      models: Array<Record<string, unknown> & { id?: unknown; openrouter_model_id?: unknown }>;
    }>;
  };
  for (const tier of cleanOriginal.tiers) {
    tier.models = tier.models.filter(
      (model) =>
        model.id !== freeModel.modelId && model.openrouter_model_id !== freeModel.openRouterModelId
    );
  }
  const patched = JSON.parse(JSON.stringify(cleanOriginal)) as typeof cleanOriginal;
  const firstTier = patched.tiers[0];
  if (!firstTier) throw new Error('llm_model_catalog 没有任何 tier，无法注入免费模型');
  firstTier.models.push({
    id: freeModel.modelId,
    openrouter_model_id: freeModel.openRouterModelId,
    display_name: 'MVP 回归测试免费模型',
    tagline: '仅供本地回归脚本使用',
    price_input: 0,
    price_output: 0,
    markup: freeModel.markup,
    deduct_markup: freeModel.deductMarkup,
    enabled: true,
    sort_order: firstTier.models.length,
  });

  const write = async (value: unknown, version: number) => {
    const { error: writeError } = await db()
      .from('runtime_config')
      .update({ value, version })
      .eq('key', 'llm_model_catalog');
    if (writeError) throw new Error(`写入 llm_model_catalog 失败：${writeError.message}`);
  };

  await write(patched, entry.version + 1);

  return {
    freeModel,
    async restore() {
      await write(cleanOriginal, entry.version + 2);
    },
  };
}

/** 模型选择以 miniapp_user_settings 为权威，handler 每次生成前都会用它覆盖 body.model */
export async function setSelectedModel(userId: string, modelId: string): Promise<void> {
  const { error } = await db()
    .from('miniapp_user_settings')
    .upsert({ user_id: userId, selected_model_id: modelId }, { onConflict: 'user_id' });
  if (error) throw new Error(`设置 selected_model_id 失败：${error.message}`);
}

export async function setWalletBalance(userId: string, mainCredits: number): Promise<void> {
  const { error } = await db()
    .from('user_wallets')
    .upsert(
      { user_id: userId, main_credits: mainCredits, bonus_credits: 0 },
      { onConflict: 'user_id' }
    );
  if (error) throw new Error(`设置钱包余额失败：${error.message}`);
}

export async function getWalletCredits(userId: string): Promise<number> {
  const { data, error } = await db()
    .from('user_wallets')
    .select('main_credits, bonus_credits, total_credits')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`查询钱包失败：${error.message}`);
  if (!data) return 0;
  const row = data as { main_credits: number; bonus_credits: number; total_credits: number | null };
  return Number(row.total_credits ?? Number(row.main_credits) + Number(row.bonus_credits));
}

/**
 * 直接把已用轮次顶到 limit - 1，用来测「最后一轮免费 → 下一轮按 deduct_markup 计费」的边界。
 */
export async function setFreeQuotaUsedRounds(
  userId: string,
  characterId: string,
  usedRounds: number
): Promise<void> {
  const { error } = await db()
    .from('character_free_chat_quotas')
    .upsert(
      { user_id: userId, character_id: characterId, used_rounds: usedRounds, reserved_rounds: 0 },
      { onConflict: 'user_id,character_id' }
    );
  if (error) throw new Error(`设置免费额度已用轮次失败：${error.message}`);
}

export async function getFreeQuotaUsedRounds(userId: string, characterId: string): Promise<number> {
  const { data, error } = await db()
    .from('character_free_chat_quotas')
    .select('used_rounds, reserved_rounds')
    .eq('user_id', userId)
    .eq('character_id', characterId)
    .maybeSingle();
  if (error) throw new Error(`查询免费额度失败：${error.message}`);
  return Number((data as { used_rounds?: number } | null)?.used_rounds ?? 0);
}

export interface ChatHistoryRow {
  id: string;
  model: string;
  user_input: string;
  assistant_reply: string | null;
  status: string;
  upstream_status: number | null;
  deduction_rate: number | string;
  character_id: string | null;
  preset_id: string | null;
  session_id: string | null;
  history: unknown;
  llm_charge_id: string | null;
  llm_model_markup: number | string | null;
  llm_intended_deduction: number | string | null;
  llm_generation_id: string | null;
  created_at: string;
}

export async function listChatHistory(userId: string): Promise<ChatHistoryRow[]> {
  const { data, error } = await db()
    .from('chat_history')
    .select(
      'id, model, user_input, assistant_reply, status, upstream_status, deduction_rate, character_id, preset_id, session_id, history, llm_charge_id, llm_model_markup, llm_intended_deduction, llm_generation_id, created_at'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`查询 chat_history 失败：${error.message}`);
  return (data ?? []) as ChatHistoryRow[];
}

export interface UsageChargeRow {
  charge_key: string;
  model_id: string | null;
  model_openrouter_id: string;
  model_display_name: string;
  model_markup: number | string;
  calculated_amount: number | string;
  charged_amount: number | string;
  fallback_used: boolean;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function listUsageCharges(userId: string): Promise<UsageChargeRow[]> {
  const { data, error } = await db()
    .from('llm_usage_charges')
    .select(
      'charge_key, model_id, model_openrouter_id, model_display_name, model_markup, calculated_amount, charged_amount, fallback_used, status, metadata, created_at'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`查询 llm_usage_charges 失败：${error.message}`);
  return (data ?? []) as UsageChargeRow[];
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

  const characterName = `MVP 回归测试角色 ${tag}`;
  const { data: character, error: characterError } = await db()
    .from('characters')
    .insert({
      name: characterName,
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
    characterName,
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

export interface ConversationHistoryTestRow {
  id: string;
  session_id: string;
  turn_index: number;
  revision: number;
  model: string;
  user_input: string;
  assistant_reply: string | null;
  history: unknown[];
  status: string;
  llm_finish_reason: string | null;
  llm_generation_id: string | null;
  llm_charge_id: string | null;
  created_at: string;
}

/** 含全部 revision：重生成场景要确认旧版本确实留档 */
export async function listConversationHistoryRows(
  sessionId: string
): Promise<ConversationHistoryTestRow[]> {
  const { data, error } = await db()
    .from('chat_history')
    .select('*')
    .eq('session_id', sessionId)
    .order('turn_index', { ascending: true })
    .order('revision', { ascending: true });
  if (error) throw new Error(`查询会话 chat_history 失败：${error.message}`);
  return (data ?? []) as ConversationHistoryTestRow[];
}

/**
 * 落库是在 SSE 收流之后才发生的，HTTP 响应结束时那条 UPDATE 往往还在飞。
 * 轮询到该消息离开 streaming 为止，而不是 sleep 一个拍脑袋的固定值。
 */
export async function waitForSettledHistory(
  historyId: string,
  timeoutMs = 20_000
): Promise<ConversationHistoryTestRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data, error } = await db()
      .from('chat_history')
      .select('*')
      .eq('id', historyId)
      .maybeSingle();
    if (error) throw new Error(`查询消息失败：${error.message}`);

    const row = data as ConversationHistoryTestRow | null;
    if (row && row.status !== 'streaming') return row;
    if (Date.now() >= deadline) {
      throw new Error(`等待对话轮次收口超时：${historyId} 仍为 ${row?.status ?? 'missing'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * 自研链路会在调用上游前先建 chat_history 行，不能再以「条数出现」作为异步计费完成判据。
 * llm_model_markup 由 saveChatHistory 最后补入，免费与付费模型都会有值，用它作为完成水位。
 */
export async function waitForChatHistory(
  userId: string,
  expectedCount: number,
  timeoutMs = 20_000
): Promise<ChatHistoryRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await listChatHistory(userId);
    const expectedRows = rows.slice(0, expectedCount);
    if (
      rows.length >= expectedCount &&
      expectedRows.every((row) => row.status !== 'streaming' && row.llm_model_markup !== null)
    ) {
      return rows;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 chat_history 异步元数据超时：期望 ${expectedCount} 条已补全记录`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 清掉上一个场景留下的会话与落库痕迹，让各场景的条数断言可以用绝对值 */
export async function resetConversationArtifacts(userId: string): Promise<void> {
  await db().from('chat_history').delete().eq('user_id', userId);
  await db().from('llm_usage_charges').delete().eq('user_id', userId);
  await db().from('character_free_chat_quota_decisions').delete().eq('user_id', userId);
  // chat_history.session_id 是 ON DELETE SET NULL，所以先删历史再删 session
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
