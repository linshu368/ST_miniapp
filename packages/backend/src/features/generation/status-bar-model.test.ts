import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./upstream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./upstream.js')>();
  return {
    ...actual,
    resolveProviderUpstream: () => ({ url: 'http://upstream.test', apiKey: 'test-key' }),
    forwardToUpstream: vi.fn(),
  };
});

vi.mock('./panel-call-ledger.js', () => ({ recordPanelLlmCall: vi.fn() }));

vi.mock('../../platform/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/runtime-config.js')>()),
  fetchRuntimeConfigEntry: vi.fn(),
}));

import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';
import { forwardToUpstream } from './upstream.js';
import { recordPanelLlmCall, type PanelLlmCall } from './panel-call-ledger.js';
import {
  STATUS_MODEL_PRIMARY,
  STATUS_PRIMARY_FIRST_TOKEN_MS,
  callStatusModel,
  unfinishedCode,
} from './status-bar-model.js';

const forward = vi.mocked(forwardToUpstream);
const readConfig = vi.mocked(fetchRuntimeConfigEntry);
const record = vi.mocked(recordPanelLlmCall);
const messages = { system: 's', user: 'u' };
const auto = { trigger: 'auto' as const };
const lastRecord = () => record.mock.lastCall![0] as PanelLlmCall;

const sseWith = (headers: Record<string, string>, ...events: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } }
  );
const sse = (...events: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
const delta = (content: string, finish: string | null = null) =>
  JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] });

beforeEach(() => {
  forward.mockReset();
  record.mockReset();
  readConfig.mockReset();
  readConfig.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('状态栏主通道（Surplus Gemini，流式）', () => {
  it('流式读完整段，正常结束就返回', async () => {
    forward.mockResolvedValueOnce(sse(delta('【局势】\n'), delta('体力：80%', 'stop'), '[DONE]'));
    const result = await callStatusModel('primary', messages, auto);
    expect(result).toEqual({
      content: '【局势】\n体力：80%',
      channel: 'primary',
      model: STATUS_MODEL_PRIMARY,
    });
    const body = JSON.parse(String(forward.mock.calls[0]![0].body)) as { stream: boolean };
    expect(body.stream).toBe(true);
  });

  it('首字超过 4 秒就中止，报 first_token_timeout', async () => {
    vi.useFakeTimers();
    forward.mockImplementationOnce(
      ({ signal }) =>
        new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    const pending = callStatusModel('primary', messages, auto);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'first_token_timeout',
      channel: 'primary',
    });
    await vi.advanceTimersByTimeAsync(STATUS_PRIMARY_FIRST_TOKEN_MS);
    await assertion;
  });

  it('用运营平台配的模型；配坏了用默认模型', async () => {
    const run = async (value: unknown) => {
      readConfig.mockResolvedValueOnce({ value, textValue: null, version: 3 });
      forward.mockResolvedValueOnce(sse(delta('体力：80%', 'stop'), '[DONE]'));
      const result = await callStatusModel('primary', messages, auto);
      const body = JSON.parse(String(forward.mock.lastCall![0].body)) as { model: string };
      return [result.model, body.model];
    };
    const configured = { primary_model: 'gemini-3.5-flash', fallback_model: 'deepseek/x' };
    expect(await run(configured)).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash']);
    expect(await run({ primary_model: '' })).toEqual([STATUS_MODEL_PRIMARY, STATUS_MODEL_PRIMARY]);
  });

  it('记忆栏首发用单独配的模型，没配时和状态栏一样；状态栏不受影响', async () => {
    const run = async (value: unknown, panel?: 'status' | 'memory') => {
      readConfig.mockResolvedValueOnce({ value, textValue: null, version: 4 });
      forward.mockResolvedValueOnce(sse(delta('{}', 'stop'), '[DONE]'));
      const result = await callStatusModel('primary', messages, panel ? { panel, ...auto } : auto);
      return result.model;
    };
    const split = {
      primary_model: 'gemini-3-flash-preview',
      memory_primary_model: 'deepseek-v4.1-flash-1017',
      fallback_model: 'deepseek/x',
    };
    expect(await run(split, 'memory')).toBe('deepseek-v4.1-flash-1017');
    expect(await run(split, 'status')).toBe('gemini-3-flash-preview');
    expect(await run(split)).toBe('gemini-3-flash-preview');
    const shared = { primary_model: 'gemini-3-flash-preview', fallback_model: 'deepseek/x' };
    expect(await run(shared, 'memory')).toBe('gemini-3-flash-preview');
  });

  it('没写完时按原因细分错误码，并带上原始结束原因', async () => {
    forward.mockResolvedValueOnce(sse(delta('体力：', 'content_filter'), '[DONE]'));
    await expect(callStatusModel('primary', messages, auto)).rejects.toMatchObject({
      code: 'content_filtered',
      signals: { completed: true, finishReason: 'content_filter' },
    });
    // OpenRouter 上的 Gemini 被拦：finish_reason=error，原始结束原因 SAFETY
    forward.mockResolvedValueOnce(
      sse(
        JSON.stringify({
          choices: [
            { delta: { content: '体' }, finish_reason: 'error', native_finish_reason: 'SAFETY' },
          ],
        }),
        '[DONE]'
      )
    );
    await expect(callStatusModel('primary', messages, auto)).rejects.toMatchObject({
      code: 'content_filtered',
      signals: { nativeFinishReason: 'SAFETY' },
    });
    // Surplus 断流：先发 stream_incomplete 错误块再发 [DONE]
    forward.mockResolvedValueOnce(
      sse(delta('体力：'), JSON.stringify({ error: { code: 'stream_incomplete' } }), '[DONE]')
    );
    await expect(callStatusModel('primary', messages, auto)).rejects.toMatchObject({
      code: 'stream_interrupted',
    });
    // 写满长度上限
    forward.mockResolvedValueOnce(sse(delta('体力：', 'length'), '[DONE]'));
    await expect(callStatusModel('primary', messages, auto)).rejects.toMatchObject({
      code: 'truncated',
    });
    // 既没有结束原因也没有 [DONE]
    forward.mockResolvedValueOnce(sse(delta('体力：')));
    await expect(callStatusModel('primary', messages, auto)).rejects.toMatchObject({
      code: 'stream_interrupted',
    });
  });
});

describe('没写完的原因细分（unfinishedCode）', () => {
  const s = (over: Partial<Parameters<typeof unfinishedCode>[0]>) => ({
    completed: true,
    finishReason: null,
    ...over,
  });
  it.each([
    ['截断', s({ finishReason: 'length' }), 'truncated'],
    ['content_filter 被拦', s({ finishReason: 'content_filter' }), 'content_filtered'],
    [
      'error + SAFETY 被拦',
      s({ finishReason: 'error', nativeFinishReason: 'SAFETY' }),
      'content_filtered',
    ],
    [
      'PROHIBITED_CONTENT 被拦',
      s({ finishReason: 'error', nativeFinishReason: 'PROHIBITED_CONTENT' }),
      'content_filtered',
    ],
    ['Surplus 断流错误块', s({ streamError: 'stream_incomplete' }), 'stream_interrupted'],
    ['没结束原因也没 [DONE]', s({ completed: false }), 'stream_interrupted'],
    ['上游中途报错', s({ finishReason: 'error' }), 'stream_error'],
    ['其他错误块', s({ streamError: '502' }), 'stream_error'],
    ['stop 但没收到 [DONE]', s({ completed: false, finishReason: 'stop' }), 'missing_done'],
    ['其他结束原因', s({ finishReason: 'tool_calls' }), 'unfinished_other'],
  ])('%s', (_label, signals, code) => {
    expect(unfinishedCode(signals)).toBe(code);
  });
});

describe('成本台账：每次发出去的调用都记一行，成功失败都记', () => {
  it('首发成功：Surplus 请求号、流末用量、触发方式、completed', async () => {
    forward.mockResolvedValueOnce(
      sseWith(
        { 'x-si-request-id': 'req-1' },
        delta('体力：80%', 'stop'),
        JSON.stringify({
          id: 'gen-s1',
          choices: [],
          usage: { prompt_tokens: 1200, completion_tokens: 80 },
        }),
        '[DONE]'
      )
    );
    await callStatusModel('primary', messages, { panel: 'memory', trigger: 'manual' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(lastRecord()).toMatchObject({
      provider: 'surplus',
      model: STATUS_MODEL_PRIMARY,
      panel: 'memory',
      role: 'primary',
      trigger: 'manual',
      endReason: 'completed',
      httpStatus: 200,
      requestId: 'req-1',
      promptTokens: 1200,
      completionTokens: 80,
    });
    expect(lastRecord().dispatchedAt).toBeInstanceOf(Date);
  });

  it('首字超时被掐掉也记（没收到响应头就没有请求号，成本记缺失）', async () => {
    vi.useFakeTimers();
    forward.mockImplementationOnce(
      ({ signal }) =>
        new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    const pending = callStatusModel('primary', messages, auto);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'first_token_timeout' });
    await vi.advanceTimersByTimeAsync(STATUS_PRIMARY_FIRST_TOKEN_MS);
    await assertion;
    expect(lastRecord()).toMatchObject({ endReason: 'first_token_timeout', requestId: null });
    expect(lastRecord().dispatchedAt).toBeInstanceOf(Date);
  });

  it('上游 HTTP 错误也记，带状态码', async () => {
    forward.mockResolvedValueOnce(new Response('busy', { status: 429 }));
    await expect(callStatusModel('primary', messages, auto)).rejects.toMatchObject({
      code: 'http_429',
    });
    expect(lastRecord()).toMatchObject({ endReason: 'http_429', httpStatus: 429 });
  });

  it('兜底被截断（没被采用）也记 generation id 和用量', async () => {
    forward.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'gen-f1',
          choices: [{ message: { content: '体力：' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 900, completion_tokens: 3000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    await expect(callStatusModel('fallback', messages, auto)).rejects.toMatchObject({
      code: 'truncated',
    });
    expect(lastRecord()).toMatchObject({
      provider: 'openrouter',
      role: 'fallback',
      generationId: 'gen-f1',
      promptTokens: 900,
      completionTokens: 3000,
      endReason: 'truncated',
    });
  });

  it('请求没发出去（没配密钥前就失败）不记', async () => {
    readConfig.mockRejectedValueOnce(new Error('config down'));
    await expect(callStatusModel('primary', messages, auto)).rejects.toBeTruthy();
    expect(lastRecord()?.dispatchedAt ?? null).toBeNull();
  });
});
