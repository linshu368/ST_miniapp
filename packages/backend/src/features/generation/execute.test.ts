import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistoryEntry } from '../../lib/chat-history-logger.js';
import type { GenerationLogger, GenerationRequest } from './types.js';

const pricing = {
  version: 7,
  balanceBaseline: 30,
  fallbackCost: 30,
  exchangeRate: 680,
  markup: 2.5,
  fixedDeduction: { freeQuotaExhausted: 10, light: 15, standard: 30, premium: 50 },
};

const billingContext = {
  modelId: 'anthropic-claude-sonnet-4-5',
  modelDisplayName: 'Claude Sonnet 4.5',
  openRouterModelId: 'anthropic/claude-sonnet-4.5',
  modelTier: 'premium' as const,
  catalogVersion: 12,
  modelMarkup: 2.5,
  deductMarkup: 2.5,
};

let walletBalance = 1000;

vi.mock('../../platform/model-tiers.js', () => ({
  getPricingConfig: async () => pricing,
  getModelBillingContext: async () => billingContext,
}));

vi.mock('../../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    async getOrCreate() {
      return { total_credits: walletBalance, main_credits: walletBalance, bonus_credits: 0 };
    }
  },
}));

vi.mock('../../lib/chat-history-logger.js', () => ({ saveChatHistory: vi.fn() }));

const { saveChatHistory } = await import('../../lib/chat-history-logger.js');
const { execute } = await import('./execute.js');

const savedHistory = () => vi.mocked(saveChatHistory).mock.calls.map((call) => call[0]);

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
      openRouterModelId: billingContext.openRouterModelId,
      tier: 'premium',
      markup: 2.5,
      deductMarkup: null,
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
  const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) =>
    typeof response === 'function' ? response() : response
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBodyOf(fetchMock: ReturnType<typeof stubUpstream>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '{}');
}

beforeEach(() => {
  walletBalance = 1000;
  vi.mocked(saveChatHistory).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

    const entry = savedHistory()[0] as ChatHistoryEntry;
    expect(entry).toMatchObject({
      user_id: 'user-1',
      session_id: 'session-1',
      user_input: '你好',
      assistant_reply: '你好',
      status: 'success',
      finish_reason: 'stop',
      model: 'anthropic/claude-sonnet-4.5',
      model_id: 'anthropic-claude-sonnet-4-5',
      model_markup: 2.5,
      fixed_deduction: 50,
      fixed_deduction_category: 'premium',
      pricing_config_version: 7,
      exchange_rate: 680,
    });
    expect(entry.charge_id).toBe(result.chargeId);
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

  it('收到 content_filter 仍完成落库，并把 finish_reason 交给扣费入口判 0 元', async () => {
    stubUpstream(() =>
      sseResponse([
        DELTA('敏感回复片段'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    );

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({
      status: 'success',
      content: '敏感回复片段',
      finishReason: 'content_filter',
    });
    expect(savedHistory()[0]).toMatchObject({
      status: 'success',
      assistant_reply: '敏感回复片段',
      finish_reason: 'content_filter',
    });
  });

  it('客户端不消费也照样跑完落库（断线不终止上游）', async () => {
    stubUpstream(() => sseResponse([DELTA('完整回复'), 'data: [DONE]\n\n']));

    const result = await execute(request(), undefined, fakeLogger());

    expect(result.status).toBe('success');
    expect(savedHistory()[0]).toMatchObject({ assistant_reply: '完整回复' });
  });
});

describe('execute（失败路径）', () => {
  it('余额不足在发请求前收口，不碰上游也不落库', async () => {
    walletBalance = 10;
    const fetchMock = stubUpstream(() => sseResponse([]));

    const result = await execute(request(), undefined, fakeLogger());

    expect(result).toMatchObject({
      status: 'insufficient_balance',
      chargeId: null,
      balance: { creditsRequired: 50, creditsAvailable: 10 },
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
  });
});

describe('execute（请求体）', () => {
  it('只发 model / messages / stream，采样参数为空时不出现多余字段', async () => {
    const fetchMock = stubUpstream(() => sseResponse(['data: [DONE]\n\n']));

    await execute(request(), undefined, fakeLogger());

    expect(Object.keys(requestBodyOf(fetchMock)).sort()).toEqual(['messages', 'model', 'stream']);
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
});
