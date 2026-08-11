/**
 * backend / scripts / st-regression / scenarios.ts
 *
 * §7.3 的回归场景与断言。
 *
 * 覆盖情况（对照 docs/ST_remove-MVP实施方案.md §7.3 的五条）：
 *   1. ST 链路端到端行为不变 —— 正常生成 / 402 / 上游 5xx / 流中断 / 免费额度耗尽：全覆盖
 *   2. chat_history 落库字段与重构前逐字段一致 —— 靠 observed 快照对拍（见 compare-snapshots.ts）
 *   3. charge_llm_usage 的 charge_id 幂等行为不变 —— idempotent_charge 场景
 *   5. session_id 入参在 ST 链路为 null，落库为 NULL —— 每个落库场景都顺带断言
 *
 * 第 4 条（simulation 链路不受影响）**不在本脚本覆盖范围内**：simulation 跑在独立的
 * Railway project 且连生产库，`miniapp_simulation.conversations` 在 test 库里没有数据。
 * 它的保障来自「llm-proxy 里 simulation 分支一行未动」，需要端到端确认时只能去它自己的环境。
 */

import { randomUUID } from 'node:crypto';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import { getCharacterFreeChatQuotaLimit } from '../../features/billing/free-quota.js';
import { sendStChatCompletion } from './client.js';
import { MOCK_PARTIAL_REPLY_TEXT, MOCK_REPLY_TEXT, type MockUpstream } from './mock-upstream.js';
import {
  cleanupRunArtifacts,
  getFreeQuotaUsedRounds,
  getWalletCredits,
  listChatHistory,
  listUsageCharges,
  setFreeQuotaUsedRounds,
  setSelectedModel,
  setWalletBalance,
  waitForChatHistory,
  type CatalogModelPick,
  type ChatHistoryRow,
  type SeededFixtures,
  type UsageChargeRow,
} from './fixtures.js';

const FUNDED_BALANCE = 100_000;

export interface ScenarioContext {
  baseUrl: string;
  upstream: MockUpstream;
  fixtures: SeededFixtures;
  freeModel: CatalogModelPick | null;
  paidModel: CatalogModelPick | null;
}

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
  /** 去掉了 id / 时间戳的可对拍观测值 */
  observed: Record<string, unknown>;
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

/** 快照里只保留与「行为是否变了」相关的字段，id / 时间戳一律剔除 */
function normalizeHistory(row: ChatHistoryRow) {
  return {
    model: row.model,
    user_input: row.user_input,
    assistant_reply: row.assistant_reply,
    status: row.status,
    upstream_status: row.upstream_status,
    deduction_rate: Number(row.deduction_rate),
    has_character_id: row.character_id !== null,
    preset_id: row.preset_id,
    session_id: row.session_id,
    history_length: Array.isArray(row.history) ? row.history.length : null,
    llm_model_markup: row.llm_model_markup === null ? null : Number(row.llm_model_markup),
    llm_intended_deduction:
      row.llm_intended_deduction === null ? null : Number(row.llm_intended_deduction),
  };
}

function normalizeCharge(row: UsageChargeRow) {
  return {
    model_openrouter_id: row.model_openrouter_id,
    model_display_name: row.model_display_name,
    model_markup: Number(row.model_markup),
    calculated_amount: Number(row.calculated_amount),
    charged_amount: Number(row.charged_amount),
    fallback_used: row.fallback_used,
    status: row.status,
    metadata: row.metadata,
  };
}

/** 每个场景开跑前把上一轮的落库痕迹清干净，让条数断言能直接用绝对值 */
async function resetState(
  context: ScenarioContext,
  options: { balance: number; usedRounds?: number }
): Promise<void> {
  const { userId, characterId } = context.fixtures;
  await cleanupRunArtifacts(userId);
  await setWalletBalance(userId, options.balance);
  await setFreeQuotaUsedRounds(userId, characterId, options.usedRounds ?? 0);
  context.upstream.reset();
}

// ─── 场景 1：正常生成 ─────────────────────────────────────────────────────────

async function successPaid(context: ScenarioContext): Promise<ScenarioResult> {
  const description = '付费模型正常生成：200 透传、落库 success、按定档扣费';
  const model = context.paidModel;
  if (!model) {
    return {
      name: 'success_paid',
      description,
      outcome: 'skipped',
      skipReason: '模型目录里没有启用中的付费模型（markup > 0）',
      checks: [],
      observed: {},
    };
  }

  await resetState(context, { balance: FUNDED_BALANCE });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const userInput = '外面下雨了吗？';
  const response = await sendStChatCompletion({
    baseUrl: context.baseUrl,
    userId: context.fixtures.userId,
    characterId: context.fixtures.characterId,
    userInput,
    model: model.openRouterModelId,
  });

  const history = await waitForChatHistory(context.fixtures.userId, 1);
  const charges = await listUsageCharges(context.fixtures.userId);
  const balanceAfter = await getWalletCredits(context.fixtures.userId);

  const checker = new Checker();
  checker.expect('HTTP 状态码', response.status, 200);
  checker.expectTrue('SSE 里出现 data: [DONE]', response.sawDone);
  checker.expect('透传给 ST 的正文', response.streamedContent, MOCK_REPLY_TEXT);
  checker.expect('chat_history 条数', history.length, 1);
  checker.expect('chat_history.status', history[0]?.status, 'success');
  checker.expect('chat_history.assistant_reply', history[0]?.assistant_reply, MOCK_REPLY_TEXT);
  // 用户输入取自 X-ST-User-Input，而不是 messages 末尾那条预设注入的指令
  checker.expect('chat_history.user_input 取自 header', history[0]?.user_input, userInput);
  checker.expect('chat_history.session_id 为 NULL（§7.3-5）', history[0]?.session_id, null);
  checker.expect('llm_usage_charges 条数', charges.length, 1);
  checker.expectGreaterThan('扣费金额', Number(charges[0]?.charged_amount ?? 0), 0);
  checker.expectTrue('钱包余额减少', balanceAfter < FUNDED_BALANCE);

  return {
    name: 'success_paid',
    description,
    outcome: checker.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checker.checks,
    observed: {
      http_status: response.status,
      saw_done: response.sawDone,
      streamed_content: response.streamedContent,
      chat_history: history.map(normalizeHistory),
      charges: charges.map(normalizeCharge),
      wallet_delta: balanceAfter - FUNDED_BALANCE,
    },
  };
}

// ─── 场景 2：余额不足 402 ─────────────────────────────────────────────────────

async function insufficientBalance(context: ScenarioContext): Promise<ScenarioResult> {
  const description = '余额不足：402 + 专用 statusMessage，且在碰上游之前就返回';
  const model = context.paidModel;
  if (!model) {
    return {
      name: 'insufficient_balance',
      description,
      outcome: 'skipped',
      skipReason: '模型目录里没有启用中的付费模型（markup > 0）',
      checks: [],
      observed: {},
    };
  }

  await resetState(context, { balance: 0 });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const response = await sendStChatCompletion({
    baseUrl: context.baseUrl,
    userId: context.fixtures.userId,
    characterId: context.fixtures.characterId,
    userInput: '还能聊吗？',
    model: model.openRouterModelId,
  });

  let errorType: unknown = null;
  try {
    errorType = (JSON.parse(response.body) as { error?: { type?: string } }).error?.type ?? null;
  } catch {
    errorType = null;
  }

  // 402 是同步返回的，没有 fire-and-forget 落库，直接读当前状态即可
  const history = await listChatHistory(context.fixtures.userId);
  const charges = await listUsageCharges(context.fixtures.userId);

  const checker = new Checker();
  checker.expect('HTTP 状态码', response.status, 402);
  checker.expect('statusMessage', response.statusMessage, 'MiniApp Insufficient Credits');
  checker.expect('error.type', errorType, 'insufficient_balance');
  checker.expect('上游收到的请求数（402 前不碰上游）', context.upstream.requests.length, 0);
  checker.expect('chat_history 条数', history.length, 0);
  checker.expect('llm_usage_charges 条数', charges.length, 0);

  return {
    name: 'insufficient_balance',
    description,
    outcome: checker.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checker.checks,
    observed: {
      http_status: response.status,
      status_message: response.statusMessage,
      error_type: errorType,
      upstream_request_count: context.upstream.requests.length,
      chat_history: history.map(normalizeHistory),
      charges: charges.map(normalizeCharge),
    },
  };
}

// ─── 场景 3：上游 5xx 不扣费 ──────────────────────────────────────────────────

async function upstreamError(context: ScenarioContext): Promise<ScenarioResult> {
  const description = '上游 5xx：状态码透传、落库 upstream_error、不产生扣费';
  const model = context.paidModel;
  if (!model) {
    return {
      name: 'upstream_error',
      description,
      outcome: 'skipped',
      skipReason: '模型目录里没有启用中的付费模型（markup > 0）',
      checks: [],
      observed: {},
    };
  }

  await resetState(context, { balance: FUNDED_BALANCE });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('server_error');

  const response = await sendStChatCompletion({
    baseUrl: context.baseUrl,
    userId: context.fixtures.userId,
    characterId: context.fixtures.characterId,
    userInput: '上游挂了会怎样？',
    model: model.openRouterModelId,
  });

  const history = await waitForChatHistory(context.fixtures.userId, 1);
  const charges = await listUsageCharges(context.fixtures.userId);
  const balanceAfter = await getWalletCredits(context.fixtures.userId);

  const checker = new Checker();
  checker.expect('HTTP 状态码透传', response.status, 502);
  checker.expect('chat_history.status', history[0]?.status, 'upstream_error');
  checker.expect('chat_history.upstream_status', history[0]?.upstream_status, 502);
  checker.expect('chat_history.assistant_reply', history[0]?.assistant_reply, null);
  checker.expect('chat_history.session_id 为 NULL（§7.3-5）', history[0]?.session_id, null);
  checker.expect('llm_usage_charges 条数（不扣费）', charges.length, 0);
  checker.expect('钱包余额未变', balanceAfter, FUNDED_BALANCE);

  return {
    name: 'upstream_error',
    description,
    outcome: checker.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checker.checks,
    observed: {
      http_status: response.status,
      chat_history: history.map(normalizeHistory),
      charges: charges.map(normalizeCharge),
      wallet_delta: balanceAfter - FUNDED_BALANCE,
    },
  };
}

// ─── 场景 4：流中断不扣费 ─────────────────────────────────────────────────────

async function streamInterrupted(context: ScenarioContext): Promise<ScenarioResult> {
  const description = '流中断（没有 [DONE]）：落库 stream_interrupted 且保留半截正文，不扣费';
  const model = context.paidModel;
  if (!model) {
    return {
      name: 'stream_interrupted',
      description,
      outcome: 'skipped',
      skipReason: '模型目录里没有启用中的付费模型（markup > 0）',
      checks: [],
      observed: {},
    };
  }

  await resetState(context, { balance: FUNDED_BALANCE });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('interrupted');

  const response = await sendStChatCompletion({
    baseUrl: context.baseUrl,
    userId: context.fixtures.userId,
    characterId: context.fixtures.characterId,
    userInput: '说到一半断了会怎样？',
    model: model.openRouterModelId,
  });

  const history = await waitForChatHistory(context.fixtures.userId, 1);
  const charges = await listUsageCharges(context.fixtures.userId);
  const balanceAfter = await getWalletCredits(context.fixtures.userId);

  const checker = new Checker();
  checker.expectTrue('客户端没收到 [DONE]', !response.sawDone);
  checker.expect('chat_history.status', history[0]?.status, 'stream_interrupted');
  checker.expect(
    'chat_history.assistant_reply 保留半截正文',
    history[0]?.assistant_reply,
    MOCK_PARTIAL_REPLY_TEXT
  );
  checker.expect('chat_history.session_id 为 NULL（§7.3-5）', history[0]?.session_id, null);
  checker.expect('llm_usage_charges 条数（不扣费）', charges.length, 0);
  checker.expect('钱包余额未变', balanceAfter, FUNDED_BALANCE);

  return {
    name: 'stream_interrupted',
    description,
    outcome: checker.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checker.checks,
    observed: {
      saw_done: response.sawDone,
      streamed_content: response.streamedContent,
      chat_history: history.map(normalizeHistory),
      charges: charges.map(normalizeCharge),
      wallet_delta: balanceAfter - FUNDED_BALANCE,
    },
  };
}

// ─── 场景 5：上游直接断开 socket ──────────────────────────────────────────────

async function streamAborted(context: ScenarioContext): Promise<ScenarioResult> {
  const description = '上游销毁 socket：记录既有行为（不落库、预留不终结），确认 M3a 未改变它';
  const model = context.paidModel;
  if (!model) {
    return {
      name: 'stream_aborted',
      description,
      outcome: 'skipped',
      skipReason: '模型目录里没有启用中的付费模型（markup > 0）',
      checks: [],
      observed: {},
    };
  }

  await resetState(context, { balance: FUNDED_BALANCE });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('aborted');

  // llm-proxy 是 `upstreamNodeStream.pipe(sseTap)`，源流上没有 error 监听器；socket 被销毁时
  // undici 抛的错会变成 unhandled 'error' 事件，进而打死整个进程。而且 pipe 出错时不会 end
  // 目标流，所以下游那条响应会一直挂着不结束。这两点在 M3a 前后逐字节相同
  // （见 git show ca0b226:.../llm-proxy.ts），所以这里不判它失败，只如实记录进快照，
  // 让对拍能发现「哪天它变了」。没有这层兜底的话，这个场景会直接卡死整轮回归。
  const uncaught: string[] = [];
  const onUncaught = (error: Error) => uncaught.push(error.message);
  process.on('uncaughtException', onUncaught);

  let response: Awaited<ReturnType<typeof sendStChatCompletion>> | null = null;
  let requestError: string | null = null;
  try {
    response = await sendStChatCompletion({
      baseUrl: context.baseUrl,
      userId: context.fixtures.userId,
      characterId: context.fixtures.characterId,
      userInput: '上游直接断链会怎样？',
      model: model.openRouterModelId,
      timeoutMs: 5_000,
    });
    // 落库是 fire-and-forget，给它一个窗口；这里期望的恰恰是「什么都没写进来」。
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } catch (error) {
    requestError = (error as Error).message;
  } finally {
    process.off('uncaughtException', onUncaught);
  }

  const history = await listChatHistory(context.fixtures.userId);
  const charges = await listUsageCharges(context.fixtures.userId);
  const balanceAfter = await getWalletCredits(context.fixtures.userId);

  const checker = new Checker();
  checker.expect('llm_usage_charges 条数（不扣费）', charges.length, 0);
  checker.expect('钱包余额未变', balanceAfter, FUNDED_BALANCE);

  return {
    name: 'stream_aborted',
    description,
    outcome: checker.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checker.checks,
    observed: {
      http_status: response?.status ?? null,
      streamed_content: response?.streamedContent ?? null,
      request_error: requestError,
      // 这三项是「既有行为」的指纹：目前是 1 条未捕获异常、下游响应不结束、0 条落库。
      uncaught_exception_count: uncaught.length,
      response_never_ended: response?.timedOut ?? null,
      chat_history: history.map(normalizeHistory),
      charges: charges.map(normalizeCharge),
      wallet_delta: balanceAfter - FUNDED_BALANCE,
    },
  };
}

// ─── 场景 6：免费额度耗尽的边界 ───────────────────────────────────────────────

async function freeQuotaExhaustion(context: ScenarioContext): Promise<ScenarioResult> {
  const description = '免费额度边界：最后一轮免费（0 扣费），下一轮按 deduct_markup 计费';
  const model = context.freeModel;
  if (!model) {
    return {
      name: 'free_quota_exhaustion',
      description,
      outcome: 'skipped',
      skipReason: '模型目录里没有启用中的免费模型（markup === 0）',
      checks: [],
      observed: {},
    };
  }

  const quotaLimit = await getCharacterFreeChatQuotaLimit();
  // 顶到 limit - 1：下一轮是最后一轮免费，再下一轮就该收费了。
  await resetState(context, { balance: FUNDED_BALANCE, usedRounds: quotaLimit - 1 });
  await setSelectedModel(context.fixtures.userId, model.modelId);
  context.upstream.setScenario('success');

  const lastFree = await sendStChatCompletion({
    baseUrl: context.baseUrl,
    userId: context.fixtures.userId,
    characterId: context.fixtures.characterId,
    userInput: '最后一轮免费',
    model: model.openRouterModelId,
  });
  await waitForChatHistory(context.fixtures.userId, 1);
  const usedAfterFree = await getFreeQuotaUsedRounds(
    context.fixtures.userId,
    context.fixtures.characterId
  );

  const afterExhausted = await sendStChatCompletion({
    baseUrl: context.baseUrl,
    userId: context.fixtures.userId,
    characterId: context.fixtures.characterId,
    userInput: '额度耗尽后的第一轮',
    model: model.openRouterModelId,
  });
  const history = await waitForChatHistory(context.fixtures.userId, 2);
  const charges = await listUsageCharges(context.fixtures.userId);
  const balanceAfter = await getWalletCredits(context.fixtures.userId);

  const freeCharge = charges[0];
  const paidCharge = charges[1];

  const checker = new Checker();
  checker.expect('第一轮 HTTP 状态码', lastFree.status, 200);
  checker.expect('第二轮 HTTP 状态码', afterExhausted.status, 200);
  checker.expect('免费轮用尽后 used_rounds 达到上限', usedAfterFree, quotaLimit);
  checker.expect('chat_history 条数', history.length, 2);
  checker.expect('免费轮 model_markup', Number(history[0]?.llm_model_markup ?? -1), 0);
  checker.expect('免费轮扣费额', Number(freeCharge?.charged_amount ?? -1), 0);
  checker.expect(
    '耗尽后 model_markup 等于 deduct_markup',
    Number(history[1]?.llm_model_markup ?? -1),
    model.deductMarkup
  );
  checker.expectGreaterThan('耗尽后扣费额', Number(paidCharge?.charged_amount ?? 0), 0);
  checker.expectTrue('钱包只在耗尽后那轮减少', balanceAfter < FUNDED_BALANCE);

  return {
    name: 'free_quota_exhaustion',
    description,
    outcome: checker.checks.every((check) => check.passed) ? 'passed' : 'failed',
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

// ─── 场景 7：charge_id 幂等 ───────────────────────────────────────────────────

async function idempotentCharge(context: ScenarioContext): Promise<ScenarioResult> {
  const description = 'charge_llm_usage 幂等：同一个 charge_id 重复提交只扣一次（§7.3-3）';
  const model = context.paidModel;
  if (!model) {
    return {
      name: 'idempotent_charge',
      description,
      outcome: 'skipped',
      skipReason: '模型目录里没有启用中的付费模型（markup > 0）',
      checks: [],
      observed: {},
    };
  }

  await resetState(context, { balance: FUNDED_BALANCE });

  // 幂等键归 RPC 管，与 HTTP 层无关，所以这里直接打 RPC：走两次真实生成拿不到
  // 「同一个 charge_id」——handler 每轮都会 randomUUID() 一个新的。
  const wallets = new MiniappWalletRepository();
  const chargeId = randomUUID();
  const chargeInput = {
    chargeId,
    generationId: null,
    userId: context.fixtures.userId,
    modelId: model.modelId,
    modelOpenRouterId: model.openRouterModelId,
    modelDisplayName: 'ST 回归测试模型',
    catalogVersion: 1,
    pricingConfigVersion: 1,
    usageCostUsd: null,
    exchangeRate: 680,
    modelMarkup: model.markup,
    calculatedAmount: 10,
    fallbackUsed: false,
    metadata: { chat_status: 'success', billing_mode: 'fixed_tier' },
  };

  const first = await wallets.chargeLlmUsage(chargeInput);
  const balanceAfterFirst = await getWalletCredits(context.fixtures.userId);
  const second = await wallets.chargeLlmUsage(chargeInput);
  const balanceAfterSecond = await getWalletCredits(context.fixtures.userId);
  const charges = await listUsageCharges(context.fixtures.userId);

  const checker = new Checker();
  checker.expectTrue('首次提交不是 already_charged', !first.alreadyCharged);
  checker.expectTrue('二次提交被识别为 already_charged', second.alreadyCharged);
  checker.expect('扣费明细只有一条', charges.length, 1);
  checker.expect('二次提交后余额不再变化', balanceAfterSecond, balanceAfterFirst);
  checker.expect(
    '两次返回的扣费额一致',
    Number(second.charge.charged_amount),
    Number(first.charge.charged_amount)
  );

  return {
    name: 'idempotent_charge',
    description,
    outcome: checker.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checker.checks,
    observed: {
      first_already_charged: first.alreadyCharged,
      second_already_charged: second.alreadyCharged,
      charges: charges.map(normalizeCharge),
      wallet_delta_first: balanceAfterFirst - FUNDED_BALANCE,
      wallet_delta_second: balanceAfterSecond - FUNDED_BALANCE,
    },
  };
}

export const SCENARIOS: Array<{
  name: string;
  run: (context: ScenarioContext) => Promise<ScenarioResult>;
}> = [
  { name: 'success_paid', run: successPaid },
  { name: 'insufficient_balance', run: insufficientBalance },
  { name: 'upstream_error', run: upstreamError },
  { name: 'stream_interrupted', run: streamInterrupted },
  { name: 'stream_aborted', run: streamAborted },
  { name: 'free_quota_exhaustion', run: freeQuotaExhaustion },
  { name: 'idempotent_charge', run: idempotentCharge },
];
