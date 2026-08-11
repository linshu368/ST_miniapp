/**
 * backend / scripts / st-regression / fixtures.ts
 *
 * 测试数据的播种、读回与清理。
 *
 * 全部打 test 库（与 M1 集成测试同一套），因为 §7.3 那五条判据依赖真实的钱包、
 * 免费额度与 charge_llm_usage RPC——mock 掉数据库等于什么都没验。
 *
 * 角色卡必须 enabled = false + is_test = true + 带 card_hash，否则会被 migration 062 的
 * characters_test_cards_disabled 约束拦下（同时也保证测试卡不会出现在大厅里）。
 */

import { getSupabaseClient } from '../../lib/supabase.js';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';

/** 所有测试数据都带这个前缀，sweepOrphanFixtures 靠它辨认自己留下的东西 */
const FIXTURE_PREFIX = 'st-regr-';

export interface SeededFixtures {
  userId: string;
  characterId: string;
  /** 用于清理与日志定位 */
  tag: string;
}

export interface CatalogModelPick {
  /** 目录 stable id，写进 miniapp_user_settings.selected_model_id */
  modelId: string;
  openRouterModelId: string;
  markup: number;
  deductMarkup: number | null;
}

function db() {
  return getSupabaseClient().schema('miniapp');
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
 *    version 需要手动 +1：它不是触发器维护的，而是发布 RPC 显式写的，而 model-tiers
 *    的缓存判活只认这个字段（见 shouldReuseCatalogCache）。
 */
export async function seedFreeModelIntoCatalog(): Promise<CatalogOverride> {
  // 直接查表而不是复用 platform/runtime-config.ts：那个模块是 M2 才有的，而本脚本需要
  // 在重构前的 commit 上原样跑一遍做对拍（见 run.ts 头部的对拍步骤）。
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
    modelId: 'st-regression-free',
    openRouterModelId: 'st-regression/free-model',
    markup: 0,
    deductMarkup: 2,
  };

  const patched = JSON.parse(JSON.stringify(original)) as typeof original;
  const firstTier = patched.tiers[0];
  if (!firstTier) throw new Error('llm_model_catalog 没有任何 tier，无法注入免费模型');
  firstTier.models.push({
    id: freeModel.modelId,
    openrouter_model_id: freeModel.openRouterModelId,
    display_name: 'ST 回归测试免费模型',
    tagline: '仅供本地回归脚本使用',
    // 免费模型必须展示价为 0，否则整份目录会校验失败并静默回退到默认目录
    price_input: 0,
    price_output: 0,
    markup: freeModel.markup,
    deduct_markup: freeModel.deductMarkup,
    enabled: true,
    sort_order: firstTier.models.length,
  });

  const write = async (value: unknown, version: number) => {
    const { error } = await db()
      .from('runtime_config')
      .update({ value, version })
      .eq('key', 'llm_model_catalog');
    if (error) throw new Error(`写入 llm_model_catalog 失败：${error.message}`);
  };

  await write(patched, entry.version + 1);

  return {
    freeModel,
    async restore() {
      await write(original, entry.version + 2);
    },
  };
}

export async function seedFixtures(): Promise<SeededFixtures> {
  const tag = `${FIXTURE_PREFIX}${Date.now().toString(36)}`;

  const { data: user, error: userError } = await db()
    .from('users')
    .insert({ tg_id: `${tag}-user`, st_handle: tag.replace(/-/g, '_') })
    .select('id')
    .single();
  if (userError) throw new Error(`创建测试用户失败：${userError.message}`);
  const userId = (user as { id: string }).id;

  const { data: character, error: characterError } = await db()
    .from('characters')
    .insert({
      name: `ST 回归测试角色 ${tag}`,
      first_mes: '（回归测试开场白）',
      system_prompt: '你是一个用于 ST 链路回归测试的角色。',
      enabled: false,
      is_test: true,
      card_hash: tag,
    })
    .select('id')
    .single();
  if (characterError) throw new Error(`创建测试角色卡失败：${characterError.message}`);
  const characterId = (character as { id: string }).id;

  return { userId, characterId, tag };
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
 * 老老实实跑满 40 轮要几分钟，且每轮都要过一次上游。
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

/**
 * chat_history 是 fire-and-forget 落库（见 lib/chat-history-logger.ts），HTTP 响应结束时
 * 那条 insert 往往还在飞。轮询到期望条数为止，而不是 sleep 一个拍脑袋的固定值。
 */
export async function waitForChatHistory(
  userId: string,
  expectedCount: number,
  timeoutMs = 20_000
): Promise<ChatHistoryRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = await listChatHistory(userId);
  while (rows.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    rows = await listChatHistory(userId);
  }
  if (rows.length < expectedCount) {
    throw new Error(`等待 chat_history 落库超时：期望 ${expectedCount} 条，实际 ${rows.length} 条`);
  }
  return rows;
}

/**
 * 清掉上一个场景留下的落库痕迹，但保留用户与角色卡本身。
 * 有了它，各场景的条数断言可以直接用绝对值，不必到处算差量。
 */
export async function cleanupRunArtifacts(userId: string): Promise<void> {
  await db().from('chat_history').delete().eq('user_id', userId);
  await db().from('llm_usage_charges').delete().eq('user_id', userId);
  await db().from('character_free_chat_quota_decisions').delete().eq('user_id', userId);
}

/**
 * 清掉历史遗留的测试数据。
 *
 * stream_aborted 那个场景会触发未捕获异常，进程被打死或被 Ctrl-C 时 cleanupFixtures
 * 跑不到，测试用户就会攒在库里。开跑前先扫一遍，比指望每次都优雅退出可靠。
 */
export async function sweepOrphanFixtures(): Promise<number> {
  const { data, error } = await db().from('users').select('id').like('tg_id', `${FIXTURE_PREFIX}%`);
  if (error) throw new Error(`扫描遗留测试用户失败：${error.message}`);

  const userIds = (data ?? []).map((row) => (row as { id: string }).id);
  for (const userId of userIds) {
    await cleanupUserData(userId);
    await db().from('users').delete().eq('id', userId);
  }
  await db().from('characters').delete().like('card_hash', `${FIXTURE_PREFIX}%`);
  return userIds.length;
}

async function cleanupUserData(userId: string): Promise<void> {
  // users 的几个 FK 大多是 ON DELETE CASCADE，但显式删一遍才不依赖各表当前的约束形态。
  await db().from('chat_history').delete().eq('user_id', userId);
  await db().from('llm_usage_charges').delete().eq('user_id', userId);
  await db().from('character_free_chat_quota_decisions').delete().eq('user_id', userId);
  await db().from('character_free_chat_quotas').delete().eq('user_id', userId);
  await db().from('user_wallets').delete().eq('user_id', userId);
  await db().from('miniapp_user_settings').delete().eq('user_id', userId);
}

export async function cleanupFixtures(fixtures: SeededFixtures): Promise<void> {
  await cleanupUserData(fixtures.userId);
  await db().from('users').delete().eq('id', fixtures.userId);
  await db().from('characters').delete().eq('id', fixtures.characterId);
}
