/**
 * backend / scripts / mvp-regression / scenarios.ts
 *
 * §8.3 的 MVP 验收场景与断言：不经过 ST、不经过 iframe、不经过 bridge，
 * 纯 HTTP 客户端把「建会话 → 发消息 → SSE → 落库计费 → 重生成」跑完。
 *
 * 与 §8.3 的对应关系：
 *   1 建会话返回开场白            → create_session
 *   2 发消息拿到流式 token + 落库 → send_message
 *   3 免费额度边界                → free_quota（需要 --seed-free-model）
 *   4 余额不足 402                → insufficient_balance
 *   5 重生成最后一轮              → regenerate
 *   6 客户端中途断开仍落完整内容  → client_disconnect
 *   7 会话列表直读 DB             → create_session 顺带断言（列表内容 + 全程零上游请求）
 *
 * 另加 conflict_guards：409 的两种形态（会话忙 / 不是最后一轮），它们是 SSE 首字节写出
 * 之前必须以 HTTP 状态码返回的判定，走错了前端就得从流里认错误。
 */

import type {
  ChatMessage,
  CreateConversationData,
  GetConversationData,
  ListConversationsData,
} from '@miniapp/shared';
import { getSupabaseClient } from '../../lib/supabase.js';
import { getCharacterFreeChatQuotaLimit } from '../../features/billing/free-quota.js';
import { MOCK_REPLY_TEXT, type MockUpstream } from './mock-upstream.js';
import { buildInitData, callApi } from './client.js';

export interface CheckResult {
  label: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface ScenarioResult {
  name: string;
  description: string;
  outcome: 'passed' | 'failed' | 'skipped';
  skipReason?: string;
  checks: CheckResult[];
  observed: Record<string, unknown>;
}
import {
  CHARACTER_SYSTEM_PROMPT,
  OPENING_MESSAGE,
  getFreeQuotaUsedRounds,
  getSessionRow,
  getWalletCredits,
  listChatHistory,
  listConversationHistoryRows,
  listUsageCharges,
  resetConversationArtifacts,
  setFreeQuotaUsedRounds,
  setSelectedModel,
  setWalletBalance,
  waitForChatHistory,
  waitForSettledHistory,
  type CatalogModelPick,
  type ChatHistoryRow,
  type ConversationFixtures,
  type UsageChargeRow,
} from './fixtures.js';

const FUNDED_BALANCE = 100_000;

export interface MvpScenarioContext {
  baseUrl: string;
  upstream: MockUpstream;
  fixtures: ConversationFixtures;
  freeModel: CatalogModelPick | null;
  paidModel: CatalogModelPick | null;
}

class Checker {
  readonly checks: CheckResult[] = [];

  expect(label: string, actual: unknown, expected: unknown): void {
    this.checks.push({
      label,
      passed: JSON.stringify(actual) === JSON.stringify(expected),
      expected,
      actual,
    });
  }

  expectTrue(label: string, actual: boolean): void {
    this.checks.push({ label, passed: actual, expected: true, actual });
  }

  expectGreaterThan(label: string, actual: number, threshold: number): void {
    this.checks.push({
      label,
      passed: Number.isFinite(actual) && actual > threshold,
      expected: `> ${threshold}`,
      actual,
    });
  }
}

function outcomeOf(checker: Checker): 'passed' | 'failed' {
  return checker.checks.every((check) => check.passed) ? 'passed' : 'failed';
}

function skipped(name: string, description: string, reason: string): ScenarioResult {
  return { name, description, outcome: 'skipped', skipReason: reason, checks: [], observed: {} };
}

function normalizeHistory(row: ChatHistoryRow) {
  return {
    model: row.model,
    user_input: row.user_input,
    assistant_reply: row.assistant_reply,
    status: row.status,
    upstream_status: row.upstream_status,
    deduction_rate: Number(row.deduction_rate),
    has_session_id: row.session_id !== null,
    preset_id: row.preset_id,
    history_length: Array.isArray(row.history) ? row.history.length : null,
  };
}

function normalizeCharge(row: UsageChargeRow) {
  return {
    model_openrouter_id: row.model_openrouter_id,
    model_markup: Number(row.model_markup),
    calculated_amount: Number(row.calculated_amount),
    charged_amount: Number(row.charged_amount),
    status: row.status,
  };
}

function normalizeMessage(message: ChatMessage) {
  return {
    turn_index: message.turn_index,
    role: message.role,
    revision: message.revision,
    content: message.content,
    status: message.status,
    error_code: message.error_code,
  };
}

/** promptCaching 打开后 Claude 系模型的 content 会变成分块数组，两种形态都要能取到文本 */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''
    )
    .join('');
}

function upstreamMessages(upstream: MockUpstream, index = 0): Array<Record<string, unknown>> {
  const body = upstream.requests[index]?.body as { messages?: unknown } | undefined;
  return Array.isArray(body?.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
}

async function resetState(
  context: MvpScenarioContext,
  options: { balance: number; usedRounds?: number }
): Promise<void> {
  const { userId, characterId } = context.fixtures;
  await resetConversationArtifacts(userId);
  await setWalletBalance(userId, options.balance);
  await setFreeQuotaUsedRounds(userId, characterId, options.usedRounds ?? 0);
  context.upstream.reset();
}

function initDataOf(context: MvpScenarioContext): string {
  return buildInitData(context.fixtures.tgId);
}

async function createSession(context: MvpScenarioContext): Promise<CreateConversationData> {
  const response = await callApi<{ success: boolean; data: CreateConversationData }>({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'POST',
    path: '/api/v1/conversations',
    body: { character_id: context.fixtures.characterId },
  });
  if (response.status !== 200 || !response.json?.data) {
    throw new Error(`建会话失败：${response.status} ${response.body.slice(0, 300)}`);
  }
  return response.json.data;
}

async function sendMessage(
  context: MvpScenarioContext,
  sessionId: string,
  content: string,
  options: { abortAfterDeltas?: number } = {}
) {
  return await callApi({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'POST',
    path: `/api/v1/conversations/${sessionId}/messages`,
    body: { content },
    abortAfterDeltas: options.abortAfterDeltas,
    timeoutMs: 30_000,
  });
}

// ─── 场景 1：建会话 + 会话列表直读 DB（§8.3 第 1、8 条）──────────────────────

async function createSessionScenario(context: MvpScenarioContext): Promise<ScenarioResult> {
  const name = 'create_session';
  const description = '建会话返回虚拟开场白；会话列表与详情直读 DB，全程零上游请求';

  await resetState(context, { balance: FUNDED_BALANCE });
  const created = await createSession(context);

  const list = await callApi<{ data: ListConversationsData }>({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'GET',
    path: `/api/v1/conversations?character_id=${context.fixtures.characterId}`,
  });
  const detail = await callApi<{ data: GetConversationData }>({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'GET',
    path: `/api/v1/conversations/${created.session.id}`,
  });

  const opening = created.messages[0];
  const checker = new Checker();
  checker.expect('开场白条数', created.messages.length, 1);
  checker.expect(
    '开场白是 turn 0 的 assistant 消息',
    [opening?.turn_index, opening?.role],
    [0, 'assistant']
  );
  checker.expect('开场白正文取自角色卡 first_mes', opening?.content, OPENING_MESSAGE);
  checker.expect('开场白状态', opening?.status, 'complete');
  checker.expect('未发生用户对话时 message_count 为 0', created.session.message_count, 0);
  checker.expect(
    '会话未重命名时 title 为角色名',
    created.session.title,
    context.fixtures.characterName
  );
  checker.expect('列表 total', list.json?.data.total, 1);
  checker.expect('列表命中新建的会话', list.json?.data.sessions[0]?.id, created.session.id);
  checker.expect('详情消息条数', detail.json?.data.messages.length, 1);
  checker.expect('详情 has_more', detail.json?.data.has_more, false);
  checker.expect('全程未碰上游（§8.3-8）', context.upstream.requests.length, 0);

  return {
    name,
    description,
    outcome: outcomeOf(checker),
    checks: checker.checks,
    observed: {
      messages: created.messages.map(normalizeMessage),
      message_count: created.session.message_count,
      list_total: list.json?.data.total ?? null,
      upstream_request_count: context.upstream.requests.length,
    },
  };
}

// ─── 场景 2：发消息 + SSE + 落库（§8.3 第 2 条）───────────────────────────────

async function sendMessageScenario(context: MvpScenarioContext): Promise<ScenarioResult> {
  const name = 'send_message';
  const description = '发消息：SSE start/delta/done、chat_history 作为唯一轮次记录并收口';
  const model = context.paidModel;
  if (!model) return skipped(name, description, '模型目录里没有启用中的付费模型（markup > 0）');

  await resetState(context, { balance: FUNDED_BALANCE });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const session = await createSession(context);
  const userInput = '外面下雨了吗？';
  const response = await sendMessage(context, session.session.id, userInput);

  const start = response.events.find((event) => event.type === 'start');
  const done = response.events.find((event) => event.type === 'done');
  const assistantMessageId = start?.type === 'start' ? start.assistant_message_id : '';
  const assistantRow = assistantMessageId ? await waitForSettledHistory(assistantMessageId) : null;
  const history = await waitForChatHistory(context.fixtures.userId, 1);
  const charges = await listUsageCharges(context.fixtures.userId);
  const balanceAfter = await getWalletCredits(context.fixtures.userId);
  const sessionRow = await getSessionRow(session.session.id);

  const sent = upstreamMessages(context.upstream);
  const lastSent = messageText(sent[sent.length - 1]);
  const openingOccurrences = sent.filter(
    (message) => messageText(message) === OPENING_MESSAGE
  ).length;

  const checker = new Checker();
  checker.expect('HTTP 状态码', response.status, 200);
  checker.expectTrue(
    'Content-Type 是 SSE',
    String(response.headers['content-type'] ?? '').includes('text/event-stream')
  );
  checker.expect('首帧是 start', response.events[0]?.type, 'start');
  checker.expect('start.turn_index', start?.type === 'start' ? start.turn_index : null, 1);
  checker.expect('start.revision', start?.type === 'start' ? start.revision : null, 0);
  checker.expectTrue(
    'start 带上了本轮 user 消息 id',
    start?.type === 'start' && typeof start.user_message_id === 'string'
  );
  checker.expect('流式还原出的正文', response.streamedContent, MOCK_REPLY_TEXT);
  checker.expect('终帧 status', done?.type === 'done' ? done.status : null, 'complete');

  // prompt 组装：M1 的上下文 → M2 的 history + userInput 这条接缝
  checker.expect('system 段是角色卡 system_prompt', messageText(sent[0]), CHARACTER_SYSTEM_PROMPT);
  checker.expect('历史里开场白只出现一次', openingOccurrences, 1);
  checker.expect('最后一条是 user', sent[sent.length - 1]?.role, 'user');
  checker.expectTrue('最后一条包含平台规则包装', lastSent.includes('##系统指令'));
  checker.expectTrue('最后一条包含本轮用户输入', lastSent.includes(userInput));
  checker.expect(
    '上游收到的模型',
    (context.upstream.requests[0]?.body as { model?: string })?.model,
    model.openRouterModelId
  );

  checker.expect('轮次行收口状态', assistantRow?.status, 'success');
  checker.expect('轮次行正文', assistantRow?.assistant_reply, MOCK_REPLY_TEXT);
  checker.expect('轮次行模型', assistantRow?.model, model.openRouterModelId);
  checker.expectTrue('轮次行保存完整 prompt 快照', (assistantRow?.history.length ?? 0) > 0);
  checker.expectTrue('轮次行写入 charge_id', assistantRow?.llm_charge_id != null);
  checker.expect('会话 message_count（用户 + assistant）', sessionRow?.message_count, 2);

  checker.expect('chat_history 条数', history.length, 1);
  checker.expect('chat_history.status', history[0]?.status, 'success');
  checker.expect('chat_history.user_input', history[0]?.user_input, userInput);
  checker.expect('chat_history.assistant_reply', history[0]?.assistant_reply, MOCK_REPLY_TEXT);
  checker.expect('chat_history.session_id 非空', history[0]?.session_id, session.session.id);
  checker.expect('llm_usage_charges 条数', charges.length, 1);
  checker.expectGreaterThan('扣费金额', Number(charges[0]?.charged_amount ?? 0), 0);
  checker.expectTrue('钱包余额减少', balanceAfter < FUNDED_BALANCE);

  return {
    name,
    description,
    outcome: outcomeOf(checker),
    checks: checker.checks,
    observed: {
      http_status: response.status,
      event_types: response.events.map((event) => event.type),
      streamed_content: response.streamedContent,
      upstream_message_roles: sent.map((message) => message.role),
      chat_history: history.map(normalizeHistory),
      charges: charges.map(normalizeCharge),
      wallet_delta: balanceAfter - FUNDED_BALANCE,
    },
  };
}

// ─── 场景：免费额度边界──────────────────────────────────────────────────────

async function freeQuotaScenario(context: MvpScenarioContext): Promise<ScenarioResult> {
  const name = 'free_quota';
  const description = '免费额度边界：最后一轮免费（0 扣费），下一轮按 deduct_markup 计费';
  const model = context.freeModel;
  if (!model) {
    return skipped(
      name,
      description,
      '模型目录里没有启用中的免费模型（用 --seed-free-model 注入）'
    );
  }

  const quotaLimit = await getCharacterFreeChatQuotaLimit();
  await resetState(context, { balance: FUNDED_BALANCE, usedRounds: quotaLimit - 1 });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const session = await createSession(context);
  await sendMessage(context, session.session.id, '最后一轮免费');
  await waitForChatHistory(context.fixtures.userId, 1);
  const usedAfterFree = await getFreeQuotaUsedRounds(
    context.fixtures.userId,
    context.fixtures.characterId
  );

  await sendMessage(context, session.session.id, '额度耗尽后的第一轮');
  const history = await waitForChatHistory(context.fixtures.userId, 2);
  const charges = await listUsageCharges(context.fixtures.userId);
  const balanceAfter = await getWalletCredits(context.fixtures.userId);

  const checker = new Checker();
  checker.expect('免费轮用尽后 used_rounds 达到上限', usedAfterFree, quotaLimit);
  checker.expect('chat_history 条数', history.length, 2);
  checker.expect('免费轮扣费额', Number(charges[0]?.charged_amount ?? -1), 0);
  checker.expect(
    '耗尽后按 deduct_markup 计费',
    Number(history[1]?.llm_model_markup ?? -1),
    model.deductMarkup
  );
  checker.expectGreaterThan('耗尽后扣费额', Number(charges[1]?.charged_amount ?? 0), 0);
  checker.expectTrue('钱包只在耗尽后那轮减少', balanceAfter < FUNDED_BALANCE);

  return {
    name,
    description,
    outcome: outcomeOf(checker),
    checks: checker.checks,
    observed: {
      quota_limit: quotaLimit,
      used_rounds_after_free: usedAfterFree,
      chat_history: history.map(normalizeHistory),
      charges: charges.map(normalizeCharge),
      wallet_delta: balanceAfter - FUNDED_BALANCE,
    },
  };
}

// ─── 场景 5：余额不足 402（§8.3 第 5 条）─────────────────────────────────────

async function insufficientBalanceScenario(context: MvpScenarioContext): Promise<ScenarioResult> {
  const name = 'insufficient_balance';
  const description = '余额不足：402 JSON（不是流内错误）、不碰上游、assistant 行收口成 failed';
  const model = context.paidModel;
  if (!model) return skipped(name, description, '模型目录里没有启用中的付费模型（markup > 0）');

  await resetState(context, { balance: 0 });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const session = await createSession(context);
  const response = await sendMessage(context, session.session.id, '还能聊吗？');

  const body = response.json as { error?: { type?: string; credits_required?: number } } | null;
  // 必须在下面那次「充值后重发」之前定格：那一轮是会真打上游的，晚读就把它算进来了。
  const upstreamCountAt402 = context.upstream.requests.length;
  const rows = await listConversationHistoryRows(session.session.id);
  const assistantRow = rows.find((row) => row.turn_index === 1);
  const history = await listChatHistory(context.fixtures.userId);
  const charges = await listUsageCharges(context.fixtures.userId);

  // 402 之后会话不能被那条占位行卡住：充值后下一次发送要能正常起流
  await setWalletBalance(context.fixtures.userId, FUNDED_BALANCE);
  const retry = await sendMessage(context, session.session.id, '充值之后再试一次');

  const checker = new Checker();
  checker.expect('HTTP 状态码', response.status, 402);
  checker.expectTrue(
    '响应是 JSON 而不是 SSE',
    !String(response.headers['content-type'] ?? '').includes('text/event-stream')
  );
  checker.expect('error.type', body?.error?.type, 'insufficient_balance');
  checker.expect('没有下发任何 SSE 事件', response.events.length, 0);
  checker.expect('402 前不碰上游', upstreamCountAt402, 0);
  checker.expect('轮次行收口成 insufficient_balance', assistantRow?.status, 'insufficient_balance');
  checker.expect('chat_history 条数', history.length, 1);
  checker.expect('llm_usage_charges 条数', charges.length, 0);
  checker.expect('充值后重发不被 409 卡住', retry.status, 200);

  return {
    name,
    description,
    outcome: outcomeOf(checker),
    checks: checker.checks,
    observed: {
      http_status: response.status,
      error_type: body?.error?.type ?? null,
      upstream_request_count_at_402: upstreamCountAt402,
      assistant_status: assistantRow?.status ?? null,
      assistant_error_code: assistantRow?.status ?? null,
      retry_status: retry.status,
    },
  };
}

// ─── 场景 6：重生成最后一轮（§8.3 第 6 条）───────────────────────────────────

async function regenerateScenario(context: MvpScenarioContext): Promise<ScenarioResult> {
  const name = 'regenerate';
  const description = '重生成最后一轮：新 revision 生效、旧版本留档、上下文不重复本轮输入';
  const model = context.paidModel;
  if (!model) return skipped(name, description, '模型目录里没有启用中的付费模型（markup > 0）');

  await resetState(context, { balance: FUNDED_BALANCE });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const session = await createSession(context);
  const userInput = '接下来发生了什么？';
  await sendMessage(context, session.session.id, userInput);
  await waitForChatHistory(context.fixtures.userId, 1);

  const response = await callApi({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'POST',
    path: `/api/v1/conversations/${session.session.id}/regenerate`,
    body: {},
    timeoutMs: 30_000,
  });
  const start = response.events.find((event) => event.type === 'start');
  const assistantMessageId = start?.type === 'start' ? start.assistant_message_id : '';
  if (assistantMessageId) await waitForSettledHistory(assistantMessageId);

  const rows = await listConversationHistoryRows(session.session.id);
  const turnRows = rows.filter((row) => row.turn_index === 1);
  const currentRevision = Math.max(...turnRows.map((row) => row.revision));
  const detail = await callApi<{ data: GetConversationData }>({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'GET',
    path: `/api/v1/conversations/${session.session.id}`,
  });

  // 重生成那次请求的 prompt：本轮 user 输入只应出现在最后一条包装体里
  const sent = upstreamMessages(context.upstream, 1);
  const rawUserInputInHistory = sent
    .slice(0, -1)
    .filter((message) => messageText(message) === userInput).length;

  const checker = new Checker();
  checker.expect('HTTP 状态码', response.status, 200);
  checker.expect('start.revision', start?.type === 'start' ? start.revision : null, 1);
  checker.expect(
    '重生成不带 user_message_id',
    start?.type === 'start' ? start.user_message_id : 'missing',
    null
  );
  checker.expect('该轮 assistant 版本数', turnRows.length, 2);
  checker.expect('当前版本是最大 revision 1', currentRevision, 1);
  checker.expect('旧版本留档', turnRows[0]?.revision, 0);
  checker.expect('详情接口只下发生效版本', detail.json?.data.messages.length, 3);
  checker.expect('本轮输入未在历史里重复出现', rawUserInputInHistory, 0);

  return {
    name,
    description,
    outcome: outcomeOf(checker),
    checks: checker.checks,
    observed: {
      http_status: response.status,
      turn_versions: turnRows.map((row) => ({
        revision: row.revision,
        is_active: row.revision === currentRevision,
        status: row.status,
      })),
      detail_messages: (detail.json?.data.messages ?? []).map(normalizeMessage),
    },
  };
}

// ─── 场景 7：客户端中途断开（§8.3 第 7 条）───────────────────────────────────

async function clientDisconnectScenario(context: MvpScenarioContext): Promise<ScenarioResult> {
  const name = 'client_disconnect';
  const description = '客户端收到第一片就断开：后端跑完上游并落完整正文（相对 ST 的净改进）';
  const model = context.paidModel;
  if (!model) return skipped(name, description, '模型目录里没有启用中的付费模型（markup > 0）');

  await resetState(context, { balance: FUNDED_BALANCE });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const session = await createSession(context);
  const response = await sendMessage(context, session.session.id, '我马上就切后台', {
    abortAfterDeltas: 1,
  });

  const rows = await listConversationHistoryRows(session.session.id);
  const assistantId = rows.find((row) => row.turn_index === 1)?.id;
  const assistantRow = assistantId ? await waitForSettledHistory(assistantId) : null;
  const history = await waitForChatHistory(context.fixtures.userId, 1);

  const checker = new Checker();
  checker.expectTrue('客户端确实是中途断开的', response.aborted);
  checker.expectTrue(
    '客户端只收到了部分正文',
    response.streamedContent.length < MOCK_REPLY_TEXT.length
  );
  checker.expect('后端仍把完整正文落库', assistantRow?.assistant_reply, MOCK_REPLY_TEXT);
  checker.expect('后端仍按正常收口', assistantRow?.status, 'success');
  checker.expect('chat_history 仍有一条 success', history[0]?.status, 'success');
  checker.expect('chat_history 正文完整', history[0]?.assistant_reply, MOCK_REPLY_TEXT);

  return {
    name,
    description,
    outcome: outcomeOf(checker),
    checks: checker.checks,
    observed: {
      client_received_chars: response.streamedContent.length,
      persisted_chars: assistantRow?.assistant_reply?.length ?? null,
      assistant_status: assistantRow?.status ?? null,
      chat_history: history.map(normalizeHistory),
    },
  };
}

// ─── 场景 8：409 的两种形态 ──────────────────────────────────────────────────

async function conflictGuardsScenario(context: MvpScenarioContext): Promise<ScenarioResult> {
  const name = 'conflict_guards';
  const description = '409 在写出 SSE 首字节之前判定：会话忙 / 不是最后一轮';

  await resetState(context, { balance: FUNDED_BALANCE });
  context.upstream.setScenario('success');
  const session = await createSession(context);

  // 只有开场白的会话不能重生成（该轮没有 user 消息）
  const regenerateTooEarly = await callApi<{ error?: { code?: string } }>({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'POST',
    path: `/api/v1/conversations/${session.session.id}/regenerate`,
    body: {},
    timeoutMs: 15_000,
  });

  // 直接注入一条未收口的 streaming 行，比抢一个真实生成窗口稳定得多
  const db = getSupabaseClient().schema('miniapp');
  const { error: insertError } = await db.from('chat_history').insert({
    user_id: context.fixtures.userId,
    model: 'mvp-regression/busy',
    user_input: '未收口测试输入',
    assistant_reply: null,
    history: [],
    character_id: context.fixtures.characterId,
    session_id: session.session.id,
    turn_index: 1,
    revision: 0,
    status: 'streaming',
  });
  if (insertError) throw new Error(`注入 streaming 行失败：${insertError.message}`);

  const busy = await sendMessage(context, session.session.id, '这会儿应该被拦住');

  const missing = await callApi<{ error?: { code?: string } }>({
    baseUrl: context.baseUrl,
    initData: initDataOf(context),
    method: 'GET',
    path: '/api/v1/conversations/00000000-0000-4000-8000-000000000000',
  });

  const checker = new Checker();
  checker.expect('只有开场白时重生成被拒', regenerateTooEarly.status, 409);
  checker.expect(
    '错误码是 regenerate_not_allowed',
    (regenerateTooEarly.json as { error?: { code?: string } } | null)?.error?.code,
    'regenerate_not_allowed'
  );
  checker.expect('会话忙时返回 409', busy.status, 409);
  checker.expect(
    '错误码是 session_busy',
    (busy.json as { error?: { code?: string } } | null)?.error?.code,
    'session_busy'
  );
  checker.expect('409 不下发任何 SSE 事件', busy.events.length, 0);
  checker.expect('409 时未碰上游', context.upstream.requests.length, 0);
  checker.expect('他人 / 不存在的会话返回 404', missing.status, 404);
  checker.expect(
    '错误码是 session_not_found',
    (missing.json as { error?: { code?: string } } | null)?.error?.code,
    'session_not_found'
  );

  return {
    name,
    description,
    outcome: outcomeOf(checker),
    checks: checker.checks,
    observed: {
      regenerate_too_early_status: regenerateTooEarly.status,
      busy_status: busy.status,
      missing_status: missing.status,
      upstream_request_count: context.upstream.requests.length,
    },
  };
}

export const SCENARIOS: Array<{
  name: string;
  run: (context: MvpScenarioContext) => Promise<ScenarioResult>;
}> = [
  { name: 'create_session', run: createSessionScenario },
  { name: 'send_message', run: sendMessageScenario },
  { name: 'free_quota', run: freeQuotaScenario },
  { name: 'insufficient_balance', run: insufficientBalanceScenario },
  { name: 'regenerate', run: regenerateScenario },
  { name: 'client_disconnect', run: clientDisconnectScenario },
  { name: 'conflict_guards', run: conflictGuardsScenario },
];
