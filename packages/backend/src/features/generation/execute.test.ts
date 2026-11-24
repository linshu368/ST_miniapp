import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../platform/config.js';
import { CHAT_MAX_VISIBLE_CHARS } from './generation-stream.js';
import type { GenerationSettlementEntry } from './settle.js';
import type { GenerationLogger, GenerationRequest } from './types.js';
import type { LlmModelProvider } from '@miniapp/shared';
import {
  GenerationAbortReason,
  generationFailureFields,
  deliveryFailureFields,
} from './failure-diagnostics.js';
import { ConversationPersistenceError } from '../../infrastructure/repositories/conversation-errors.js';
import { WalletInsufficientBalanceError } from '../../infrastructure/repositories/wallet-errors.js';

const originalVeniceConfig = { ...config.venice };

describe('generation failure ownership diagnostics', () => {
  it('preserves execution deadline semantics for existing timeout consumers', () => {
    const reason = new GenerationAbortReason('EXECUTION_DEADLINE');
    expect(reason.name).toBe('TimeoutError');
    expect(generationFailureFields(reason, AbortSignal.abort(reason))).toMatchObject({
      failure_kind: 'dependency_timeout',
      cancel_source: 'deadline',
      outcome: 'timed_out',
    });
  });
  it('only lowers a proven user stop and never hides a coincident persistence failure', () => {
    const stop = new GenerationAbortReason('USER_STOP');
    const signal = AbortSignal.abort(stop);
    const wrapped = new Error('pipeline stopped', { cause: stop });
    wrapped.name = 'AbortError';
    expect(generationFailureFields(wrapped, signal)).toMatchObject({
      failure_kind: 'user_stop',
      cancel_source: 'user_stop',
    });
    expect(
      generationFailureFields(new ConversationPersistenceError(new Error('DB failure')), signal)
    ).toMatchObject({ failure_kind: 'db_write_failed', failed_stage: 'history_finalize' });
    expect(
      generationFailureFields(new DOMException('unrelated', 'AbortError'), signal).failure_kind
    ).toBe('unknown');
  });
  it('keeps permanent delivery conflicts distinct without inventing the rejected guard', () => {
    expect(deliveryFailureFields(new Error('fixed', { cause: { code: 'PT409' } }))).toEqual({
      failure_kind: 'delivery_conflict',
      failed_stage: 'delivery_select',
      delivery_conflict_reason: 'unknown',
    });
  });
});

const pricing = {
  version: 7,
  fixedDeduction: { light: 15, standard: 30, premium: 50 },
};

const defaultBillingContext = {
  modelId: 'anthropic-claude-sonnet-4-5',
  modelDisplayName: 'Claude Sonnet 4.5',
  provider: 'openrouter' as LlmModelProvider,
  providerModelId: 'anthropic/claude-sonnet-4.5',
  openRouterModelId: 'anthropic/claude-sonnet-4.5',
  modelTier: 'premium' as const,
  catalogVersion: 12,
};

let walletBalance = 1000;
let providerPreferences: Record<string, unknown> | null = null;
let billingContext = { ...defaultBillingContext };
const preparation = vi.hoisted(() => ({
  readBilling: vi.fn(),
  readRouting: vi.fn(),
  readWallet: vi.fn(),
  readRoutingConfig: vi.fn(async () => ({ rules: [] })),
}));
vi.mock('./creator-billing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./creator-billing.js')>()),
  getCharacterCreatorOwner: vi.fn(async () => null),
}));
const telemetry = vi.hoisted(() => ({
  chat: vi.fn(),
  dispatch: vi.fn(),
  attempt: vi.fn(),
  prepare: vi.fn(),
  terminal: vi.fn(),
}));
const providerAlerts = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('../../lib/engineering-observability.js', () => ({
  observeChatFirstToken: telemetry.chat,
  observeGenerationDispatch: telemetry.dispatch,
  observeGenerationAttempt: telemetry.attempt,
  observeGenerationPrepare: telemetry.prepare,
  observeGenerationTerminal: telemetry.terminal,
}));
vi.mock('./provider-alerts.js', () => ({
  observeLlmProviderResponse: providerAlerts.observe,
}));

vi.mock('../../platform/model-tiers.js', () => ({
  getPricingConfig: async () => pricing,
  getModelBillingContext: preparation.readBilling,
}));

vi.mock('../../platform/provider-routing.js', () => ({
  getProviderPreferencesForModels: preparation.readRouting,
  getProviderRoutingConfig: preparation.readRoutingConfig,
}));

vi.mock('../../platform/vip-strategy.js', () => ({
  readVipStrategy: async () => ({
    purchaseEnabled: false,
    remindersEnabled: false,
    plans: {
      month: {
        price_cents: 2888,
        duration_days: 31,
        bonus_credits: 3000,
        title: '月卡',
        description: '31 天 VIP，赠送 3000 专项星尘',
        badge_text: null,
      },
    },
    plansVersion: 1,
    discountRate: 0.95,
    discountVersion: 1,
    checkin: 150,
    checkinVersion: 1,
    limits: { voice: 3, basic_image: 3 },
    limitsVersion: 1,
    fallbacks: [],
  }),
}));

vi.mock('../../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    findByUserId = preparation.readWallet;
  },
}));

vi.mock('./settle.js', () => ({ settleGeneration: vi.fn() }));
// 出字后兜底默认关闭（个别用例打开）；真实读取走 Supabase 客户端会占用被替换的全局 fetch。
const recoveryConfig = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./chat-recovery-config.js', () => ({
  readChatRecoveryConfig: async () => recoveryConfig.value,
}));
// 模型目录固定为「声明了 reasoning」；请求体映射用真实的 surplusReasoningBody
vi.mock('./surplus-reasoning.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./surplus-reasoning.js')>()),
  getSurplusReasoningParameters: async (_modelId: string, requestedEnabled: boolean) => ({
    parameters: {},
    supportedParameters: ['reasoning'],
    requestedEnabled,
    control: 'effort',
    reason: 'effort_mapped',
  }),
}));

const { settleGeneration } = await import('./settle.js');
const { execute, prepareGeneration } = await import('./execute.js');

const savedHistory = () => vi.mocked(settleGeneration).mock.calls.map((call) => call[0]);

function fakeLogger(): GenerationLogger {
  const sink = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
    child: vi.fn(),
  };
  return Object.assign({ ...sink }, { biz: sink, sys: sink }) as unknown as GenerationLogger;
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    userId: 'user-1',
    characterId: '11111111-2222-4333-8444-555555555555',
    model: {
      modelId: billingContext.modelId,
      provider: billingContext.provider,
      providerModelId: billingContext.providerModelId,
      openRouterModelId: billingContext.openRouterModelId,
      tier: 'premium',
      entitlement: { active: true, validUntil: '2099-01-01T00:00:00.000Z' },
    },
    messages: [
      { role: 'system', content: '角色卡 system_prompt' },
      { role: 'assistant', content: '开场白' },
      { role: 'user', content: '平台规则 + 你好' },
    ],
    sampling: {},
    userInput: '你好',
    sessionId: 'session-1',
    stream: true,
    promptCaching: false,
    ...overrides,
  };
}

function sseResponse(lines: string[], init: { status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const DELTA = (content: string) =>
  `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content } }] })}\n\n`;

function stubUpstream(response: Response | (() => Response)) {
  const fetchMock = vi.fn(async (_url: string, _init?: { body?: string; signal?: AbortSignal }) =>
    typeof response === 'function' ? response() : response
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBodyOf(fetchMock: ReturnType<typeof stubUpstream>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '{}');
}

beforeEach(() => {
  Object.values(telemetry).forEach((fn) => fn.mockClear());
  providerAlerts.observe.mockClear();
  preparation.readBilling.mockReset().mockImplementation(async () => billingContext);
  preparation.readRouting
    .mockReset()
    .mockImplementation(async (ids: string[]) => ids.map(() => providerPreferences));
  walletBalance = 1000;
  preparation.readWallet
    .mockReset()
    .mockImplementation(async () => ({ main_credits: walletBalance, bonus_credits: 0 }));
  preparation.readRoutingConfig.mockClear();
  providerPreferences = null;
  billingContext = { ...defaultBillingContext };
  vi.mocked(settleGeneration).mockClear();
  recoveryConfig.value = null;
  // CI 无真实密钥；多供应商合并后缺 key 会提前 upstream_error，单测自备占位值。
  vi.stubEnv('LLM_API_KEY', 'test-llm-key');
  // Venice 单测 stub 全局 fetch；清空本地代理避免走 undici ProxyAgent
  Object.assign(config.venice, { ...originalVeniceConfig, httpsProxy: '' });
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(config.venice, originalVeniceConfig);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('execute（流式）', () => {
  it('收到 [DONE] 即成功：内容拼接、落库带 session_id、计费快照与 ST 链路同口径', async () => {
    stubUpstream(() =>
      sseResponse([
        DELTA('你'),
        DELTA('好'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );

    const deltas: string[] = [];
    const result = await execute(
      request(),
      { onDelta: (delta) => deltas.push(delta) },
      fakeLogger()
    );

    expect(result).toMatchObject({
      status: 'success',
      content: '你好',
      generationId: 'gen-1',
      finishReason: 'stop',
      modelId: 'anthropic-claude-sonnet-4-5',
      modelOpenRouterId: 'anthropic/claude-sonnet-4.5',
    });
    expect(result.chargeId).toBeTruthy();
    expect(deltas).toEqual(['你', '好']);

    const entry = savedHistory()[0] as GenerationSettlementEntry;
    expect(entry).toMatchObject({
      user_id: 'user-1',
      session_id: 'session-1',
      user_input: '你好',
      assistant_reply: '你好',
      status: 'success',
      finish_reason: 'stop',
      model: 'anthropic/claude-sonnet-4.5',
      model_id: 'anthropic-claude-sonnet-4-5',
      model_markup: 1,
      fixed_deduction: 48,
      fixed_deduction_category: 'premium',
      pricing_config_version: 7,
      exchange_rate: 1,
    });
    expect(entry.charge_id).toBe(result.chargeId);
    expect(telemetry.dispatch).toHaveBeenCalledOnce();
    expect(telemetry.attempt).toHaveBeenCalledOnce();
    expect(telemetry.terminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'success', stream: true })
    );
  });

  it('正文和 [DONE] 完整但 finish_reason 暂缺时按成功落库并等待异步结算', async () => {
    stubUpstream(() => sseResponse([DELTA('完整回复'), 'data: [DONE]\n\n']));

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({
      status: 'success',
      content: '完整回复',
      generationId: 'gen-1',
      finishReason: null,
    });
    expect(savedHistory()[0]).toMatchObject({
      status: 'success',
      assistant_reply: '完整回复',
      generation_id: 'gen-1',
      finish_reason: null,
    });
  });

  it('没有 [DONE] 判为中断，落 stream_interrupted 且不进扣费', async () => {
    stubUpstream(() => sseResponse([DELTA('半句')]));

    const result = await execute(request(), undefined, fakeLogger());

    expect(result.status).toBe('stream_interrupted');
    expect(result.content).toBe('半句');
    expect(savedHistory()[0]).toMatchObject({
      status: 'stream_interrupted',
      assistant_reply: '半句',
    });
  });

  it('可见正文超过上限时中止上游，按 length 中断收口，保留已生成部分', async () => {
    const chunk = '字'.repeat(Math.ceil(CHAT_MAX_VISIBLE_CHARS * 0.6));
    stubUpstream(() =>
      sseResponse([DELTA(chunk), DELTA(chunk), DELTA('不该收到的尾巴'), 'data: [DONE]\n\n'])
    );

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({ status: 'stream_interrupted', finishReason: 'length' });
    expect(result.content.length).toBeGreaterThan(CHAT_MAX_VISIBLE_CHARS);
    expect(result.content).not.toContain('不该收到的尾巴');
    expect(savedHistory()[0]).toMatchObject({
      status: 'stream_interrupted',
      finish_reason: 'length',
    });
  });

  it('推理内容不计入可见正文上限', async () => {
    const reasoning = (text: string) =>
      `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { reasoning: text } }] })}\n\n`;
    stubUpstream(() =>
      sseResponse([
        reasoning('想'.repeat(20_000)),
        reasoning('想'.repeat(20_000)),
        DELTA('完整回复'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({ status: 'success', content: '完整回复', finishReason: 'stop' });
  });

  it('内容过滤有正文也按 incomplete 收口且不扣费', async () => {
    stubUpstream(() =>
      sseResponse([
        DELTA('敏感回复片段'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: '敏感回复片段',
      finishReason: 'content_filter',
    });
    expect(savedHistory()[0]).toMatchObject({
      status: 'stream_interrupted',
      assistant_reply: '敏感回复片段',
      finish_reason: 'content_filter',
    });
    expect(telemetry.terminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'filtered', stream: true })
    );
    expect(telemetry.attempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'filtered', phase: 'generation' })
    );
  });

  it('自然结束但没有正文按 empty 收口且不扣费', async () => {
    stubUpstream(() =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: '',
      finishReason: 'stop',
    });
    expect(savedHistory()[0]).toMatchObject({
      status: 'stream_interrupted',
      assistant_reply: null,
      finish_reason: 'stop',
    });
  });

  it('上游 2xx 但没有响应体也按 empty 收口', async () => {
    stubUpstream(() => new Response(null, { status: 200 }));

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({ status: 'stream_interrupted', content: '' });
    expect(savedHistory()[0]).toMatchObject({
      status: 'stream_interrupted',
      assistant_reply: null,
    });
  });

  it('达到长度上限时保留正文并按 incomplete 收口', async () => {
    stubUpstream(() =>
      sseResponse([
        DELTA('还没说完'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: '还没说完',
      finishReason: 'length',
    });
    expect(telemetry.terminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'length', stream: true })
    );
    expect(telemetry.attempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'length', phase: 'generation' })
    );
  });

  it('客户端不消费也照样跑完落库（断线不终止上游）', async () => {
    stubUpstream(() =>
      sseResponse([
        DELTA('完整回复'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );

    const result = await execute(request(), undefined, fakeLogger());

    expect(result.status).toBe('success');
    expect(savedHistory()[0]).toMatchObject({ assistant_reply: '完整回复' });
  });
});

describe('execute（失败路径）', () => {
  it('an atomic admission rejection after a passing read returns the existing balance result without dispatch', async () => {
    const fetchMock = stubUpstream(() => sseResponse([]));
    const result = await execute(
      request(),
      {
        onBeforeDispatch: async () => {
          throw new WalletInsufficientBalanceError('TOTAL_CREDITS_INSUFFICIENT', {
            details: JSON.stringify({ credits_required: 48, credits_available: 5 }),
          });
        },
      },
      fakeLogger()
    );
    expect(result).toMatchObject({
      status: 'insufficient_balance',
      chargeId: null,
      balance: { creditsRequired: 48, creditsAvailable: 5 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedHistory()).toHaveLength(0);
  });
  it('标准或旗舰在 VIP 无效时不调用上游', async () => {
    const fetchMock = stubUpstream(() => sseResponse([]));
    const result = await execute(
      request({
        model: {
          modelId: billingContext.modelId,
          provider: billingContext.provider,
          providerModelId: billingContext.providerModelId,
          openRouterModelId: billingContext.openRouterModelId,
          tier: 'premium',
          entitlement: { active: false, validUntil: null },
        },
      }),
      undefined,
      fakeLogger()
    );

    expect(result).toMatchObject({
      status: 'upstream_error',
      denial: 'vip_required',
      chargeId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedHistory()).toHaveLength(0);
  });

  it('余额不足在发请求前收口，不碰上游也不落库', async () => {
    walletBalance = 10;
    const fetchMock = stubUpstream(() => sseResponse([]));

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({
      status: 'insufficient_balance',
      chargeId: null,
      balance: { creditsRequired: 48, creditsAvailable: 10 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedHistory()).toHaveLength(0);
  });

  it('上游非 2xx：不扣费，落 upstream_error 并带上状态码', async () => {
    stubUpstream(() => new Response('rate limited', { status: 429 }));

    const onError = vi.fn();
    const result = await execute(request(), { onError }, fakeLogger());

    expect(result).toMatchObject({
      status: 'upstream_error',
      upstreamStatus: 429,
      chargeId: null,
    });
    expect(savedHistory()[0]).toMatchObject({
      status: 'upstream_error',
      upstream_status: 429,
      assistant_reply: null,
    });
    expect(onError).toHaveBeenCalled();
    expect(providerAlerts.observe).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      status: 429,
    });
  });
});

it('上游请求带有服务端生成超时信号', async () => {
  const fetchMock = stubUpstream(() =>
    sseResponse([
      DELTA('完整回复'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ])
  );

  await execute(request(), undefined, fakeLogger());

  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

describe('execute（请求体）', () => {
  it('defaults OpenRouter reasoning on without adding sampling fields', async () => {
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(request(), undefined, fakeLogger());

    expect(Object.keys(requestBodyOf(fetchMock)).sort()).toEqual([
      'messages',
      'model',
      'reasoning',
      'stream',
    ]);
    expect(requestBodyOf(fetchMock).reasoning).toEqual({ enabled: true, exclude: false });
  });

  it('命中供应商路由规则时请求体带 provider 字段', async () => {
    providerPreferences = { ignore: ['alibaba'], order: ['friendli'], allow_fallbacks: true };
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(request(), undefined, fakeLogger());

    const body = requestBodyOf(fetchMock);
    expect(body.provider).toEqual({
      ignore: ['alibaba'],
      order: ['friendli'],
      allow_fallbacks: true,
    });
  });

  it('promptCaching=false 时 content 全是字符串（ST 链路的行为零变化判据）', async () => {
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(request({ promptCaching: false }), undefined, fakeLogger());

    const body = requestBodyOf(fetchMock) as { messages: Array<{ content: unknown }> };
    expect(body.messages.every((message) => typeof message.content === 'string')).toBe(true);
  });

  it('promptCaching=true 且模型是 anthropic 时注入 cache_control 断点', async () => {
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(request({ promptCaching: true }), undefined, fakeLogger());

    const body = requestBodyOf(fetchMock) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: '角色卡 system_prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages[2]?.content).toBe('平台规则 + 你好');
  });

  it('Venice defaults reasoning on and uses its own flags/cache instead of OpenRouter routing', async () => {
    providerPreferences = { ignore: ['alibaba'], order: ['friendli'], allow_fallbacks: true };
    billingContext = {
      ...defaultBillingContext,
      modelId: 'venice-model',
      modelDisplayName: 'Venice Model',
      provider: 'venice',
      providerModelId: 'venice-uncensored',
      openRouterModelId: 'venice-uncensored',
    };
    vi.stubEnv('VENICE_API_KEY', 'test-venice-key');
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(
      request({
        model: {
          modelId: 'venice-model',
          provider: 'venice',
          providerModelId: 'venice-uncensored',
          openRouterModelId: 'venice-uncensored',
          tier: 'premium',
          entitlement: { active: true, validUntil: '2099-01-01T00:00:00.000Z' },
        },
        promptCaching: true,
      }),
      undefined,
      fakeLogger()
    );

    const body = requestBodyOf(fetchMock) as {
      model: unknown;
      messages: Array<{ content: unknown }>;
      provider?: unknown;
      prompt_cache_key?: unknown;
      venice_parameters?: unknown;
      reasoning?: unknown;
      stream_options?: unknown;
    };
    expect(body.model).toBe('venice-uncensored');
    expect(body.provider).toBeUndefined();
    expect(body.messages.every((message) => typeof message.content === 'string')).toBe(true);
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      disable_thinking: false,
      strip_thinking_response: false,
    });
    expect(body.reasoning).toEqual({ enabled: true });
    expect(body.prompt_cache_key).toBe('session:session-1');
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('Surplus turns hidden thinking off when the deep-thinking switch is off', async () => {
    billingContext = {
      ...defaultBillingContext,
      modelId: 'surplus-model',
      modelDisplayName: 'Surplus Model',
      provider: 'surplus',
      providerModelId: 'google/gemini-3.8-flash',
      openRouterModelId: 'google/gemini-3.8-flash',
    };
    vi.stubEnv('SURPLUS_API_BASE_URL', 'https://surplus.example/api/v1');
    vi.stubEnv('SURPLUS_API_KEY', 'test-surplus-key');
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(
      request({
        model: {
          modelId: 'surplus-model',
          provider: 'surplus',
          providerModelId: 'google/gemini-3.8-flash',
          openRouterModelId: 'google/gemini-3.8-flash',
          tier: 'light',
          entitlement: { active: true, validUntil: '2099-01-01T00:00:00.000Z' },
        },
        thinkingEnabled: false,
      }),
      undefined,
      fakeLogger()
    );

    const body = requestBodyOf(fetchMock) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('Surplus uses only standard Chat Completions fields', async () => {
    providerPreferences = { ignore: ['alibaba'], order: ['friendli'], allow_fallbacks: true };
    billingContext = {
      ...defaultBillingContext,
      modelId: 'surplus-model',
      modelDisplayName: 'Surplus Model',
      provider: 'surplus',
      providerModelId: 'anthropic/claude-haiku-5.5',
      openRouterModelId: 'anthropic/claude-haiku-5.5',
    };
    vi.stubEnv('SURPLUS_API_BASE_URL', 'https://surplus.example/api/v1');
    vi.stubEnv('SURPLUS_API_KEY', 'test-surplus-key');
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(
      request({
        model: {
          modelId: 'surplus-model',
          provider: 'surplus',
          providerModelId: 'anthropic/claude-haiku-5.5',
          openRouterModelId: 'anthropic/claude-haiku-5.5',
          tier: 'premium',
          entitlement: { active: true, validUntil: '2099-01-01T00:00:00.000Z' },
        },
        promptCaching: true,
      }),
      undefined,
      fakeLogger()
    );

    const body = requestBodyOf(fetchMock) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      stream: true,
    });
    expect(body.provider).toBeUndefined();
    // 深度思考开关按 Surplus 的 reasoning.effort 写法发（默认开 = medium），不套 OpenRouter 的 enabled/exclude
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.venice_parameters).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it.each(['openrouter', 'venice'] as const)(
    '%s maps explicit off without platform parameter leakage',
    async (provider) => {
      billingContext = { ...defaultBillingContext, provider };
      vi.stubEnv('VENICE_API_KEY', 'test-venice-key');
      const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));
      await execute(request({ thinkingEnabled: false }), undefined, fakeLogger());
      const body = requestBodyOf(fetchMock);
      if (provider === 'openrouter') {
        expect(body.reasoning).toEqual({ enabled: false, exclude: true });
        expect(body.venice_parameters).toBeUndefined();
      } else {
        expect(body.reasoning).toEqual({ enabled: false });
        expect(body.venice_parameters).toEqual({
          include_venice_system_prompt: false,
          disable_thinking: true,
          strip_thinking_response: true,
        });
      }
      expect(body.reasoning_effort).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
});

describe('reasoning is progress, never a roleplay answer or billing proof', () => {
  it('enabled reasoning selects one attempt before forwarding and keeps its delayed answer/billing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const order: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(
                () =>
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ id: 'primary-gen', choices: [{ delta: { reasoning_content: '先思考' } }] })}\n\n`
                    )
                  ),
                10
              );
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ id: 'primary-gen', choices: [{ delta: { content: '后回答' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
                  )
                );
                controller.close();
              }, 100);
            },
          })
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    const req = request({ thinkingEnabled: true });
    req.model.firstTokenPolicy = {
      timeoutMs: 30,
      fallbackTimeoutMs: 20,
      deadlineMs: 60,
      timeoutRateTarget: 0.01,
      catalogVersion: 12,
    };
    const selectDelivery = vi.fn(async () => {
      order.push('persist delivery');
    });
    const prepareFallback = vi.fn(async () => {});
    req.firstToken = {
      primaryAttemptId: 'attempt-primary',
      requestStartedAt: performance.now(),
      store: { observe: vi.fn(async () => {}), selectDelivery, prepareFallback },
    };
    const onFirstToken = vi.fn(() => {
      order.push('first token');
    });
    const pendingResult = execute(
      req,
      {
        onFirstToken,
        onReasoningDelta: (text) => order.push(text),
        onDelta: (text) => order.push(text),
      },
      fakeLogger()
    );
    await vi.advanceTimersByTimeAsync(101);
    const result = await pendingResult;
    vi.useRealTimers();
    expect(result).toMatchObject({ status: 'success', content: '后回答' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prepareFallback).not.toHaveBeenCalled();
    expect(selectDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ generation_id: 'primary-gen', role: 'primary' })
    );
    expect(order).toEqual(['persist delivery', 'first token', '先思考', '后回答']);
    expect(onFirstToken).toHaveBeenCalledTimes(1);
    expect(savedHistory()).toHaveLength(1);
    expect(savedHistory()[0]?.assistant_reply).toBe('后回答');
    expect(JSON.stringify(savedHistory())).not.toContain('先思考');
  });

  it('streams reasoning separately and persists only the final answer', async () => {
    const reasoning = vi.fn();
    const answer = vi.fn();
    const logger = fakeLogger();
    stubUpstream(
      sseResponse([
        `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { reasoning: 'private test thought' } }] })}\n\n`,
        DELTA('最终正文'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );
    const result = await execute(
      request(),
      { onReasoningDelta: reasoning, onDelta: answer },
      logger
    );
    expect(reasoning).toHaveBeenCalledExactlyOnceWith('private test thought');
    expect(answer).toHaveBeenCalledExactlyOnceWith('最终正文');
    expect(result).toMatchObject({ status: 'success', content: '最终正文' });
    expect(JSON.stringify(savedHistory())).not.toContain('private test thought');
    expect(JSON.stringify(vi.mocked(logger.biz.info).mock.calls)).not.toContain(
      'private test thought'
    );
  });

  it.each([true, false])(
    'reasoning-only with switch %s cannot be charged',
    async (thinkingEnabled) => {
      const reasoning = vi.fn();
      stubUpstream(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'provider thought' } }] })}\n\n`,
          DELTA('<think>legacy thought</think>'),
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      );
      const result = await execute(
        request({ thinkingEnabled }),
        { onReasoningDelta: reasoning },
        fakeLogger()
      );
      expect(result).toMatchObject({
        status: 'stream_interrupted',
        content: '',
        finishReason: 'stop',
      });
      expect(savedHistory()[0]).toMatchObject({
        assistant_reply: null,
        status: 'stream_interrupted',
      });
      expect(JSON.stringify(savedHistory())).not.toContain('thought');
      if (!thinkingEnabled) expect(reasoning).not.toHaveBeenCalled();
    }
  );

  it('off suppresses even unexpected reasoning while still stripping leading legacy tags', async () => {
    const reasoning = vi.fn();
    stubUpstream(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'unexpected thought' } }] })}\n\n`,
        DELTA('<think>legacy thought</think>角色正文'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );
    const result = await execute(
      request({ thinkingEnabled: false }),
      { onReasoningDelta: reasoning },
      fakeLogger()
    );
    expect(reasoning).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'success', content: '角色正文' });
    expect(savedHistory()[0]?.assistant_reply).toBe('角色正文');
  });

  it('reveal overrides the off switch: always-thinking free models still show their thought', async () => {
    const reasoning = vi.fn();
    stubUpstream(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一想' } }] })}\n\n`,
        DELTA('角色正文'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );
    const result = await execute(
      request({ thinkingEnabled: false, revealReasoning: true }),
      { onReasoningDelta: reasoning },
      fakeLogger()
    );
    expect(reasoning).toHaveBeenCalledWith('先想一想');
    expect(result).toMatchObject({ status: 'success', content: '角色正文' });
    expect(savedHistory()[0]?.assistant_reply).toBe('角色正文');
  });

  it('non-streaming replies also keep thought out of content and await call identity before callbacks', async () => {
    const order: string[] = [];
    stubUpstream(
      new Response(
        JSON.stringify({
          id: 'gen-1',
          choices: [
            {
              message: {
                reasoning_content: '非流式思考',
                content: '<think>重复思考</think>正文',
              },
              finish_reason: 'stop',
            },
          ],
        })
      )
    );
    const result = await execute(
      request({ stream: false }),
      {
        onGenerationId: async () => {
          order.push('persist');
        },
        onReasoningDelta: (text) => order.push(`reasoning:${text}`),
        onDelta: (text) => order.push(`answer:${text}`),
      },
      fakeLogger()
    );
    expect(order).toEqual(['persist', 'reasoning:非流式思考', 'answer:正文']);
    expect(result.content).toBe('正文');
    expect(savedHistory()[0]?.assistant_reply).toBe('正文');
  });

  it('rejected off requests never retry or echo provider reasoning into errors/logs', async () => {
    const fetchMock = stubUpstream(
      new Response(
        JSON.stringify({
          error: { message: 'Reasoning cannot be disabled: private thought' },
        }),
        { status: 400 }
      )
    );
    const error = vi.fn();
    const result = await execute(
      request({ thinkingEnabled: false }),
      { onError: error },
      fakeLogger()
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('upstream_error');
    expect(error.mock.calls[0]?.[0].message).toBe('upstream 400');
  });
});

describe('cancellation, deadlines and billing arbitration', () => {
  it.each((['partial', 'reasoning', 'empty'] as const).map((kind) => ({ kind })))(
    'a manual stop with $kind output queues its original quote',
    async ({ kind }) => {
      const reasoning = `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { reasoning: 'thought' } }] })}\n\n`;
      stubUpstream(
        sseResponse(
          kind === 'partial' ? [DELTA('partial')] : kind === 'reasoning' ? [reasoning] : []
        )
      );
      const result = await execute(
        request(),
        {
          onBeforeSettle: async (observed) => {
            return { ...observed, completed: false, finishReason: 'user_cancelled' };
          },
        },
        fakeLogger()
      );
      expect(savedHistory()[0]).toMatchObject({
        finish_reason: 'user_cancelled',
        fixed_deduction: 48,
      });
      expect(result).toMatchObject({
        status: 'stream_interrupted',
        finishReason: 'user_cancelled',
      });
    }
  );

  it('a manual stop awaiting upstream headers retains the admitted quote and charge ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          })
      )
    );
    const quote = vi.fn();
    const result = await execute(
      request({ signal: AbortSignal.timeout(30) }),
      {
        onBeforeDispatch: async (snapshot) => {
          quote(snapshot);
        },
        onBeforeSettle: async (observed) => ({ ...observed, finishReason: 'user_cancelled' }),
      },
      fakeLogger()
    );
    expect(result).toMatchObject({
      status: 'stream_interrupted',
      finishReason: 'user_cancelled',
      generationId: null,
    });
    expect(result.chargeId).toBeTruthy();
    expect(savedHistory()).toHaveLength(1);
    expect(savedHistory()[0]).toMatchObject({
      charge_id: result.chargeId,
      fixed_deduction: 48,
      finish_reason: 'user_cancelled',
      generation_id: null,
    });
    expect(quote).toHaveBeenCalledOnce();
    expect(telemetry.terminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'user_cancelled', stream: true })
    );
    expect(telemetry.attempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'user_cancelled', phase: 'generation' })
    );
  });

  it('a system deadline while awaiting headers stays a free failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          })
      )
    );
    const result = await execute(
      request({ signal: AbortSignal.timeout(30) }),
      {
        onBeforeSettle: async (observed) => observed,
      },
      fakeLogger()
    );
    expect(result.status).toBe('upstream_error');
    expect(savedHistory()).toHaveLength(0);
    expect(telemetry.terminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'timeout', stream: true })
    );
    expect(telemetry.attempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'timeout', phase: 'generation' })
    );
  });

  it('cancel winner suppresses success even after all upstream tokens and DONE arrive', async () => {
    stubUpstream(sseResponse([DELTA('late complete'), 'data: [DONE]\n\n']));
    const gate = vi.fn(async (observed) => ({
      ...observed,
      completed: false,
      finishReason: 'cancelled',
    }));
    const result = await execute(request(), { onBeforeSettle: gate }, fakeLogger());
    expect(result).toMatchObject({
      status: 'stream_interrupted',
      finishReason: 'cancelled',
      content: 'late complete',
    });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(savedHistory()).toHaveLength(1);
    expect(savedHistory()[0]).toMatchObject({
      status: 'stream_interrupted',
      finish_reason: 'cancelled',
    });
  });

  it('failed terminal claim does not send a normal success to billing', async () => {
    stubUpstream(sseResponse([DELTA('reply'), 'data: [DONE]\n\n']));
    const gate = vi.fn(async () => {
      throw new Error('CAS DB unavailable');
    });
    await expect(execute(request(), { onBeforeSettle: gate }, fakeLogger())).rejects.toThrow(
      'CAS DB unavailable'
    );
    expect(gate).toHaveBeenCalledTimes(1);
    expect(savedHistory()).toHaveLength(0);
  });

  it('DONE followed by a socket that stays open is interrupted by the deadline with one settlement', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(DELTA('reply') + 'data: [DONE]\n\n'));
      },
    });
    stubUpstream(new Response(body));
    const gate = vi.fn(async (observed) => observed);
    const result = await execute(
      request({ signal: AbortSignal.timeout(30) }),
      { onBeforeSettle: gate },
      fakeLogger()
    );
    expect(result).toMatchObject({ status: 'stream_interrupted', finishReason: 'timeout' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(savedHistory()).toHaveLength(1);
    expect(savedHistory()[0]?.status).toBe('stream_interrupted');
  });
});

describe('pre-dispatch recovery persistence', () => {
  it('reuses the selected catalog snapshot and the already-durable charge key', async () => {
    const selected = request();
    const frozen = { ...defaultBillingContext, modelId: 'frozen-model', catalogVersion: 99 };
    selected.model.billingContext = frozen;
    selected.plannedChargeId = '11111111-1111-4111-8111-111111111111';
    const reserve = vi.fn(async () => {
      expect(preparation.readRouting).toHaveBeenCalledOnce();
    });
    const beforeDispatch = vi.fn(async (snapshot) => {
      expect(snapshot).toMatchObject({
        charge_id: selected.plannedChargeId,
        model_id: frozen.modelId,
        catalog_version: frozen.catalogVersion,
      });
    });
    stubUpstream(sseResponse([DELTA('reply'), 'data: [DONE]\n\n']));
    await execute(
      selected,
      { onBeforeAdmission: reserve, onBeforeDispatch: beforeDispatch },
      fakeLogger()
    );
    expect(preparation.readBilling).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledWith(selected.plannedChargeId);
    expect(beforeDispatch).toHaveBeenCalledOnce();
  });

  it('a stop after initial charge admission cannot dispatch', async () => {
    const order: string[] = [];
    let stopped = false;
    const upstream = stubUpstream(sseResponse([DELTA('must not dispatch')]));
    await expect(
      execute(
        request({ plannedChargeId: '11111111-1111-4111-8111-111111111111' }),
        {
          onBeforeAdmission: async () => {
            stopped = true;
            order.push('persisted stop');
          },
          onBeforeDispatch: async () => {
            expect(stopped).toBe(true);
            const failure = new Error('Generation is no longer active or charge identity differs');
            Object.assign(failure, { code: 'PT409' });
            throw failure;
          },
        },
        fakeLogger()
      )
    ).rejects.toThrow('Generation is no longer active');
    order.push('worker rejected');
    expect(upstream).not.toHaveBeenCalled();
    expect(order).toEqual(['persisted stop', 'worker rejected']);
    expect(savedHistory()).toHaveLength(0);
  });

  it('stops before upstream when recovery facts cannot persist', async () => {
    const upstream = stubUpstream(sseResponse([DELTA('reply'), 'data: [DONE]\n\n']));
    const { execute } = await import('./execute.js');
    await expect(
      execute(
        request(),
        {
          onBeforeDispatch: async () => {
            throw new Error('snapshot storage failed');
          },
        },
        fakeLogger()
      )
    ).rejects.toThrow('snapshot storage failed');
    expect(upstream).not.toHaveBeenCalled();
  });
});

it('preserves a fully read non-stream response when ID persistence fails', async () => {
  stubUpstream(
    new Response(
      JSON.stringify({
        id: 'body-id',
        choices: [{ message: { content: 'received full reply' }, finish_reason: 'stop' }],
      })
    )
  );
  const onBeforeSettle = vi.fn(async (value: import('./upstream.js').SseTapResult) => value);
  const result = await execute(
    request({ stream: false }),
    {
      onGenerationId: async () => {
        throw new Error('ID storage failed');
      },
      onBeforeSettle,
    },
    fakeLogger()
  );
  expect(result).toMatchObject({ status: 'stream_interrupted', content: 'received full reply' });
  expect(onBeforeSettle).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'received full reply', completed: false })
  );
  expect(savedHistory().at(-1)).toMatchObject({
    assistant_reply: 'received full reply',
    status: 'stream_interrupted',
  });
});

describe('fixed fallback preserves one selected-model quote', () => {
  it.each(
    [{ provider: 'openrouter' as const }, { provider: 'venice' as const }].flatMap((entry) =>
      ['timeout', 'http_503', 'stream_error', 'empty'].map((failure) => ({ ...entry, failure }))
    )
  )(
    'routes $provider (failure=$failure) with one charge identity',
    async ({ provider, failure }) => {
      billingContext = { ...defaultBillingContext, provider };
      if (provider === 'venice') vi.stubEnv('VENICE_API_KEY', 'test-venice-key');
      const bodies: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          bodies.push(body);
          const fallback = bodies.length === 2;
          if (!fallback && failure === 'http_503') return new Response(null, { status: 503 });
          if (!fallback && failure === 'stream_error')
            return new Response('data: {"error":{"code":503}}\n\n');
          if (!fallback && failure === 'empty') return new Response('data: [DONE]\n\n');
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setTimeout(
                () => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ id: fallback ? 'fallback-id' : 'primary-id', choices: [{ delta: { content: fallback ? '兜底' : '首发' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
                    )
                  );
                  controller.close();
                },
                fallback ? 5 : 100
              );
              init.signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  controller.error(init.signal?.reason);
                },
                { once: true }
              );
            },
          });
          return new Response(stream);
        })
      );
      const beforeAdmission = vi.fn(),
        beforeDispatch = vi.fn(),
        selectDelivery = vi.fn(async () => {});
      const deltas: string[] = [];
      const req = request({ promptCaching: true, thinkingEnabled: false });
      req.model.firstTokenPolicy = {
        fallbackModelId: 'vendor/operator-flash',
        timeoutMs: failure === 'timeout' ? 30 : 4000,
        fallbackTimeoutMs: 200,
        deadlineMs: failure === 'timeout' ? 500 : 10000,
        timeoutRateTarget: 0.01,
        catalogVersion: 12,
      };
      req.firstToken = {
        primaryAttemptId: 'attempt-primary',
        requestStartedAt: performance.now(),
        store: {
          prepareFallback: vi.fn(async () => {}),
          observe: vi.fn(async () => {}),
          selectDelivery,
        },
      };
      const result = await execute(
        req,
        {
          onBeforeAdmission: beforeAdmission,
          onBeforeDispatch: beforeDispatch,
          onDelta: (text) => deltas.push(text),
        },
        fakeLogger()
      );
      expect(result.status).toBe('success');
      expect(deltas).toEqual(['兜底']);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.model).toBe('vendor/operator-flash');
      expect(bodies[1]).not.toHaveProperty('venice_parameters');
      expect(JSON.stringify(bodies[1]?.messages)).not.toContain('cache_control');
      expect(beforeAdmission).toHaveBeenCalledOnce();
      expect(beforeDispatch).toHaveBeenCalledOnce();
      expect(selectDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'fallback', generation_id: 'fallback-id' })
      );
      expect(savedHistory()).toHaveLength(1);
      const entry = savedHistory()[0]!;
      expect(entry).toMatchObject({
        provider: 'openrouter',
        provider_model_id: 'vendor/operator-flash',
        model_id: defaultBillingContext.modelId,
        model_display_name: defaultBillingContext.modelDisplayName,
        fixed_deduction: 48,
      });
      expect(entry.charge_id).toBe(beforeAdmission.mock.calls[0]?.[0]);
      // The loser is cancelled, not drained for a second reply or settlement.
      await new Promise((r) => setTimeout(r, 115));
      expect(savedHistory()).toHaveLength(1);
      expect(deltas).toEqual(['兜底']);
    }
  );
});

it('both attempts failing ends without a bill', async () => {
  const fetchMock = stubUpstream(() => new Response(null, { status: 503 }));
  const req = request();
  req.model.firstTokenPolicy = {
    fallbackModelId: 'vendor/operator-flash',
    timeoutMs: 4000,
    fallbackTimeoutMs: 2000,
    deadlineMs: 10000,
    timeoutRateTarget: 0.01,
    catalogVersion: 12,
  };
  req.firstToken = {
    primaryAttemptId: 'p',
    requestStartedAt: performance.now(),
    store: {
      prepareFallback: vi.fn(async () => {}),
      observe: vi.fn(async () => {}),
      selectDelivery: vi.fn(async () => {}),
    },
  };
  const result = await execute(req, undefined, fakeLogger());
  expect(result).toMatchObject({ status: 'upstream_error', upstreamStatus: 503, chargeId: null });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(req.firstToken.store.selectDelivery).not.toHaveBeenCalled();
  expect(savedHistory()).toHaveLength(1);
  expect(savedHistory()[0]).toMatchObject({ status: 'upstream_error', assistant_reply: null });
});

it.each([false, true])(
  'ends once at the shared deadline (slow fallback persistence=%s)',
  async (slowPersistence) => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          })
        );
      })
    );
    const req = request();
    req.model.firstTokenPolicy = {
      fallbackModelId: 'vendor/operator-flash',
      timeoutMs: 20,
      fallbackTimeoutMs: 40,
      deadlineMs: 80,
      timeoutRateTarget: 0.01,
      catalogVersion: 12,
    };
    req.firstToken = {
      primaryAttemptId: 'attempt-primary',
      requestStartedAt: performance.now(),
      store: {
        prepareFallback: vi.fn(async () => {
          if (slowPersistence) await new Promise((resolve) => setTimeout(resolve, 100));
        }),
        observe: vi.fn(async () => {}),
        selectDelivery: vi.fn(async () => {}),
      },
    };
    const beforeAdmission = vi.fn();
    await expect(
      execute(req, { onBeforeAdmission: beforeAdmission }, fakeLogger())
    ).rejects.toMatchObject({ name: 'FirstTokenDeadlineError', stage: 'global' });
    expect(beforeAdmission).toHaveBeenCalledOnce();
    expect(savedHistory()).toHaveLength(0);
    expect(bodies).toHaveLength(slowPersistence ? 1 : 2);
    expect(req.firstToken.store.selectDelivery).not.toHaveBeenCalled();
  }
);

describe('competing attempts share one delivery and settlement', () => {
  it('races the fallback model selected as primary on the reversed provider order', async () => {
    const providers: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        providers.push(JSON.parse(String(init.body)).provider);
        const second = providers.length === 2;
        const signal = init.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              });
              if (!second) return;
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ id: 'second-id', choices: [{ delta: { content: 'reply' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
                )
              );
              controller.close();
            },
          })
        );
      })
    );
    const req = request({ thinkingEnabled: false });
    req.model.provider = 'openrouter';
    req.model.providerModelId = 'vendor/operator-flash';
    req.model.firstTokenPolicy = {
      fallbackModelId: 'vendor/operator-flash',
      fallbackProviders: ['fast-one', 'fast-two'],
      timeoutMs: 20,
      fallbackTimeoutMs: 25,
      deadlineMs: 400,
      timeoutRateTarget: 0.01,
      catalogVersion: 12,
    };
    req.firstToken = {
      primaryAttemptId: 'primary-same-model-attempt',
      requestStartedAt: performance.now(),
      deferPersistence: true,
      store: {
        prepareFallback: vi.fn(async () => {}),
        observe: vi.fn(async () => {}),
        selectDelivery: vi.fn(async () => {}),
      },
    };

    const result = await execute(req);

    expect(result.status).toBe('success');
    expect(providers).toEqual([
      { order: ['fast-one', 'fast-two'], sort: 'latency', allow_fallbacks: true },
      { order: ['fast-two', 'fast-one'], sort: 'latency', allow_fallbacks: true },
    ]);
  });

  it.each(
    (['openrouter', 'venice'] as const).flatMap((provider) =>
      (['primary', 'fallback'] as const).map((winner) => ({ provider, winner }))
    )
  )('keeps the $winner reply with one original quote ($provider)', async ({ provider, winner }) => {
    billingContext = { ...defaultBillingContext, provider };
    if (provider === 'venice') vi.stubEnv('VENICE_API_KEY', 'test-venice-key');
    const attempts: Array<{ role: 'primary' | 'fallback'; signal: AbortSignal }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const role = attempts.length === 0 ? 'primary' : 'fallback';
        const sent = JSON.parse(String(init.body));
        if (role === 'fallback')
          expect(sent.provider).toEqual({
            order: ['fast-one', 'fast-two'],
            sort: 'latency',
            allow_fallbacks: true,
          });
        else expect(sent.provider?.sort).toBeUndefined();
        const signal = init.signal!;
        attempts.push({ role, signal });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Both contenders exceed their old stage limits. Only the shared deadline
              // can reject the first available reply after the second POST has started.
              const delay = role === winner ? 65 : 160;
              const timer = setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ id: `${role}-race-id`, choices: [{ delta: { content: `${role} reply` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
                  )
                );
                controller.close();
              }, delay);
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  controller.error(signal.reason);
                },
                { once: true }
              );
            },
          })
        );
      })
    );
    const selected = vi.fn(
      async (
        _attempt: import('../../infrastructure/repositories/GenerationObservationRepository.js').AttemptObservation
      ) => {}
    );
    const beforeAdmission = vi.fn();
    const beforeDispatch = vi.fn();
    const onReady = vi.fn();
    const deltas: string[] = [];
    const req = request({ thinkingEnabled: false });
    req.model.firstTokenPolicy = {
      fallbackModelId: 'vendor/operator-flash',
      fallbackProviders: ['fast-one', 'fast-two'],
      timeoutMs: 20,
      fallbackTimeoutMs: 25,
      deadlineMs: 400,
      timeoutRateTarget: 0.01,
      catalogVersion: 12,
    };
    req.firstToken = {
      primaryAttemptId: 'primary-race-attempt',
      requestStartedAt: performance.now(),
      deferPersistence: true,
      onReady,
      store: {
        prepareFallback: vi.fn(async () => {}),
        observe: vi.fn(async () => {}),
        selectDelivery: selected,
      },
    };
    const result = await execute(
      req,
      {
        onBeforeAdmission: beforeAdmission,
        onBeforeDispatch: beforeDispatch,
        onDelta: (text) => deltas.push(text),
      },
      fakeLogger()
    );
    expect(result).toMatchObject({ status: 'success', content: `${winner} reply` });
    expect(attempts).toHaveLength(2);
    expect(attempts.find((attempt) => attempt.role !== winner)?.signal.aborted).toBe(true);
    expect(deltas).toEqual([`${winner} reply`]);
    expect(onReady).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: winner, generation_id: `${winner}-race-id` })
    );
    expect(beforeAdmission).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(savedHistory()).toHaveLength(1);
    expect(savedHistory()[0]).toMatchObject({
      generation_id: `${winner}-race-id`,
      assistant_reply: `${winner} reply`,
      provider: winner === 'fallback' ? 'openrouter' : provider,
      provider_model_id:
        winner === 'fallback' ? 'vendor/operator-flash' : defaultBillingContext.providerModelId,
      model_id: defaultBillingContext.modelId,
      fixed_deduction: 48,
      charge_id: beforeAdmission.mock.calls[0]?.[0],
    });
  });
});

describe('early read preparation remains one frozen dispatch context', () => {
  it.each(['user', 'charge'] as const)(
    'rejects another %s identity before dispatch',
    async (identity) => {
      const input = request();
      input.plannedChargeId = 'bound-charge';
      input.preparation = prepareGeneration({
        model: input.model,
        characterId: input.characterId,
        useFallback: true,
        payer: {
          userId: identity === 'user' ? 'other-user' : input.userId,
          chargeId: identity === 'charge' ? 'other-charge' : input.plannedChargeId,
          log: fakeLogger(),
          signal: new AbortController().signal,
        },
      });
      const fetchMock = stubUpstream(() => sseResponse([]));
      await expect(execute(input)).rejects.toThrow('Generation preparation identity differs');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(savedHistory()).toHaveLength(0);
    }
  );

  it('does not add an OpenRouter config read to a direct Venice consumer', async () => {
    const input = request();
    await prepareGeneration({
      model: { ...input.model, provider: 'venice' },
      characterId: null,
      useFallback: false,
    });
    expect(preparation.readRoutingConfig).not.toHaveBeenCalled();
  });
  it('starts routing before the model resolves instead of a second config round trip', async () => {
    const input = request();
    let resolveModel!: (model: GenerationRequest['model']) => void;
    const model = new Promise<GenerationRequest['model']>((resolve) => {
      resolveModel = resolve;
    });
    const pending = prepareGeneration({ model, characterId: input.characterId, useFallback: true });
    expect(preparation.readRoutingConfig).toHaveBeenCalledOnce();
    expect(preparation.readRouting).not.toHaveBeenCalled();
    resolveModel(input.model);
    await pending;
    expect(preparation.readRouting).toHaveBeenCalledOnce();
  });

  it('overlaps one paid balance read with prompt work and never rechecks it at dispatch', async () => {
    vi.useFakeTimers();
    try {
      preparation.readWallet.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { main_credits: 1000, bonus_credits: 0 };
      });
      const fetchMock = stubUpstream(() => sseResponse([DELTA('ok'), 'data: [DONE]\n\n']));
      const input = request();
      input.plannedChargeId = 'paid-preparation';
      input.preparation = prepareGeneration({
        model: input.model,
        characterId: input.characterId,
        useFallback: false,
        payer: {
          userId: input.userId,
          chargeId: input.plannedChargeId,
          log: fakeLogger(),
          signal: new AbortController().signal,
        },
      });
      await input.preparation;
      expect(preparation.readWallet).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      // Context preparation takes 300 ms. The old serial path then needed another 200 ms.
      await vi.advanceTimersByTimeAsync(300);
      expect((await execute(input)).status).toBe('success');
      expect(preparation.readWallet).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(savedHistory()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([null, { main_credits: 1, bonus_credits: 0 }])(
    'denies an absent/empty wallet without creating one: %j',
    async (wallet) => {
      preparation.readWallet.mockResolvedValue(wallet);
      const fetchMock = stubUpstream(() => sseResponse([]));
      const input = request();
      input.plannedChargeId = 'insufficient-preparation';
      input.preparation = prepareGeneration({
        model: input.model,
        characterId: input.characterId,
        useFallback: false,
        payer: {
          userId: input.userId,
          chargeId: input.plannedChargeId,
          log: fakeLogger(),
          signal: new AbortController().signal,
        },
      });
      expect((await execute(input)).status).toBe('insufficient_balance');
      expect(preparation.readWallet).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(savedHistory()).toHaveLength(0);
    }
  );

  it('reuses already-started reads without repeating provider/config queries', async () => {
    const fetchMock = stubUpstream(() => sseResponse([DELTA('ok'), 'data: [DONE]\n\n']));
    const input = request();
    input.preparation = prepareGeneration({
      model: input.model,
      characterId: input.characterId,
      useFallback: false,
    });
    await input.preparation;
    expect(preparation.readRouting).toHaveBeenCalledOnce();
    await execute(input);
    expect(preparation.readRouting).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a preparation for another character before any upstream request', async () => {
    const fetchMock = stubUpstream(() => sseResponse([]));
    const input = request();
    input.preparation = prepareGeneration({
      model: input.model,
      characterId: 'other-character',
      useFallback: false,
    });
    await expect(execute(input)).rejects.toThrow('Generation preparation identity differs');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(savedHistory()).toHaveLength(0);
  });
});

describe('出字后兜底（中断或拒答 → 擦掉重写）', () => {
  const FALLBACK_ID = 'deepseek/deepseek-v4.1-flash-1017';
  const STOP = `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
  const DONE = 'data: [DONE]\n\n';
  const enable = () => {
    recoveryConfig.value = {
      fallback_first_token_ms: 3000,
      interruption: { enabled: true, stall_ms: 3000 },
      refusal: { enabled: true, check_chars: 10, keywords: ['我不能写'] },
    };
  };
  /** 只发这些块、不关流：模拟出字后卡住 */
  const hanging = (lines: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  const raceRequest = () => {
    const req = request();
    req.model.firstTokenPolicy = {
      fallbackModelId: FALLBACK_ID,
      timeoutMs: 2000,
      fallbackTimeoutMs: 1000,
      deadlineMs: 5000,
      timeoutRateTarget: 0.01,
      catalogVersion: 12,
    };
    req.firstToken = {
      primaryAttemptId: 'attempt-primary',
      requestStartedAt: performance.now(),
      store: {
        observe: vi.fn(async () => {}),
        selectDelivery: vi.fn(async () => {}),
        prepareFallback: vi.fn(async () => {}),
      },
    };
    return req;
  };
  /** screen 模拟客户端：收到 reset 清空，之后的增量是重写内容；seen 是清空前用户看到过的全部 */
  const run = async (responses: Array<() => Response>, advanceMs = 3500) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string; signal?: AbortSignal }) =>
      (responses[call++] ?? responses[responses.length - 1]!)()
    );
    vi.stubGlobal('fetch', fetchMock);
    let screen = '';
    let seen = '';
    let resets = 0;
    const pending = execute(
      raceRequest(),
      {
        onDelta: (text) => {
          screen += text;
          seen += text;
        },
        onReset: () => {
          resets += 1;
          screen = '';
        },
      },
      fakeLogger()
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    const result = await pending;
    vi.useRealTimers();
    const bodyOf = (index: number) =>
      JSON.parse(fetchMock.mock.calls[index]?.[1]?.body ?? '{}') as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        reasoning?: unknown;
      };
    return { result, screen, seen, resets, fetchMock, bodyOf };
  };

  it('卡顿 3 秒判中断：擦掉半段，兜底按原 messages 重写，算成功（正常扣费）', async () => {
    enable();
    const { result, screen, seen, resets, fetchMock, bodyOf } = await run([
      () => hanging([DELTA('她推开门，看见院子里')]),
      () => sseResponse([DELTA('雨下得很大，她撑着伞。'), STOP, DONE]),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen.startsWith('她推开门，看见院子里')).toBe(true);
    expect(resets).toBe(1);
    expect(screen).toBe('雨下得很大，她撑着伞。');
    expect(result).toMatchObject({ status: 'success', content: '雨下得很大，她撑着伞。' });
    const fallback = bodyOf(1);
    expect(fallback.model).toBe(FALLBACK_ID);
    expect(fallback.messages).toEqual(bodyOf(0).messages);
    expect(fallback.reasoning).toEqual({ enabled: false, exclude: true });
    expect(savedHistory().at(-1)).toMatchObject({ status: 'success' });
  });

  it('兜底没出字就失败：不擦，保留用户已看到的半段，按中断免扣', async () => {
    enable();
    const { result, screen, resets, fetchMock } = await run([
      () => hanging([DELTA('她推开门，看见院子里')]),
      () => new Response('busy', { status: 503 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resets).toBe(0);
    expect(screen).toBe('她推开门，看见院子里');
    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: '她推开门，看见院子里',
      finishReason: 'stalled',
    });
    expect(savedHistory().at(-1)).toMatchObject({ status: 'stream_interrupted' });
  });

  it('拒答照常显示，命中关键词当场掐断，擦掉后换成兜底重写', async () => {
    enable();
    const { result, screen, seen, resets, fetchMock } = await run(
      [
        () => sseResponse([DELTA('这个我不能写，'), DELTA('因为这段内容……'), STOP, DONE]),
        () => sseResponse([DELTA('雨下得很大，她撑着伞。'), STOP, DONE]),
      ],
      100
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen.startsWith('这个我不能写，')).toBe(true);
    expect(seen).not.toContain('因为这段内容');
    expect(resets).toBe(1);
    expect(screen).toBe('雨下得很大，她撑着伞。');
    expect(result).toMatchObject({ status: 'success', content: '雨下得很大，她撑着伞。' });
  });

  it('拒答涉及未成年人：不掐断、不重写，原样交付', async () => {
    enable();
    const { result, resets, fetchMock } = await run(
      [() => sseResponse([DELTA('这个我不能写，她才12岁。'), STOP, DONE])],
      100
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resets).toBe(0);
    expect(result).toMatchObject({ status: 'success', content: '这个我不能写，她才12岁。' });
  });

  const ERROR = `data: ${JSON.stringify({ error: { code: 'stream_incomplete', type: 'upstream_error' } })}\n\n`;
  const FINISH = (reason: string, content = '') =>
    `data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content }, finish_reason: reason }] })}\n\n`;
  const rewritten = () => sseResponse([DELTA('雨下得很大，她撑着伞。'), STOP, DONE]);

  it.each([
    ['错误块', [ERROR]],
    ['错误块 + [DONE]', [ERROR, DONE]],
    ['写完后又来错误块', [STOP, ERROR]],
    ['结束原因 error', [FINISH('error')]],
    ['结束原因 content_filter', [FINISH('content_filter')]],
  ])('上游报错但不关流（%s）：不等卡顿阈值，立刻掐断重写', async (_name, tail) => {
    enable();
    const { result, screen, resets, fetchMock } = await run(
      [() => hanging([DELTA('她推开门，看见院子里'), ...tail]), rewritten],
      100
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resets).toBe(1);
    expect(screen).toBe('雨下得很大，她撑着伞。');
    expect(result).toMatchObject({ status: 'success', content: '雨下得很大，她撑着伞。' });
  });

  it('内容过滤涉及未成年人：当场结束但不重写，按中断免扣', async () => {
    enable();
    const { result, resets, fetchMock } = await run(
      [() => hanging([DELTA('她才12岁，'), FINISH('content_filter')]), rewritten],
      100
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resets).toBe(0);
    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: '她才12岁，',
      finishReason: 'content_filter',
    });
  });

  it.each([
    ['stop + [DONE]', [STOP, DONE]],
    ['只有 stop', [STOP]],
    ['只有 [DONE]', [DONE]],
  ])('已经写完但上游不关流（%s）：到阈值按写完处理，不擦不重写', async (_name, tail) => {
    enable();
    const { result, screen, resets, fetchMock } = await run([
      () => hanging([DELTA('她推开门，雨停了。'), ...tail]),
      rewritten,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resets).toBe(0);
    expect(screen).toBe('她推开门，雨停了。');
    expect(result).toMatchObject({ status: 'success', content: '她推开门，雨停了。' });
    expect(savedHistory().at(-1)).toMatchObject({ status: 'success' });
  });

  it('中间的包带空的结束原因：不掐断，照常写完', async () => {
    enable();
    const { result, fetchMock } = await run(
      [() => sseResponse([FINISH('', '她推开门，'), FINISH('', '雨停了。'), STOP, DONE])],
      100
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'success', content: '她推开门，雨停了。' });
  });

  it('开关关着时：上游报错不提前掐断，读到关流为止', async () => {
    stubUpstream(() => sseResponse([DELTA('写到一半'), ERROR, DELTA('又来一段'), DONE]));
    const result = await execute(request(), {}, fakeLogger());
    expect(result).toMatchObject({ status: 'stream_interrupted', content: '写到一半又来一段' });
  });

  it('开关关着时：流内错误块（Surplus stream_incomplete）按中断记，不再当作完整交付', async () => {
    stubUpstream(() =>
      sseResponse([
        DELTA('写到一半'),
        `data: ${JSON.stringify({ error: { code: 'stream_incomplete', type: 'upstream_error' } })}\n\n`,
        DONE,
      ])
    );
    const result = await execute(request(), {}, fakeLogger());
    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: '写到一半',
      finishReason: 'error',
    });
    expect(savedHistory().at(-1)).toMatchObject({ status: 'stream_interrupted' });
  });
});
