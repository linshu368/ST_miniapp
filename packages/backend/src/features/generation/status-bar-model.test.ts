import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./upstream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./upstream.js')>();
  return {
    ...actual,
    resolveProviderUpstream: () => ({ url: 'http://upstream.test', apiKey: 'test-key' }),
    forwardToUpstream: vi.fn(),
  };
});

vi.mock('../../platform/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/runtime-config.js')>()),
  fetchRuntimeConfigEntry: vi.fn(),
}));

import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';
import { forwardToUpstream } from './upstream.js';
import {
  STATUS_MODEL_PRIMARY,
  STATUS_PRIMARY_FIRST_TOKEN_MS,
  callStatusModel,
  unfinishedCode,
} from './status-bar-model.js';

const forward = vi.mocked(forwardToUpstream);
const readConfig = vi.mocked(fetchRuntimeConfigEntry);
const messages = { system: 's', user: 'u' };

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
  readConfig.mockReset();
  readConfig.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('状态栏主通道（Surplus Gemini，流式）', () => {
  it('流式读完整段，正常结束就返回', async () => {
    forward.mockResolvedValueOnce(sse(delta('【局势】\n'), delta('体力：80%', 'stop'), '[DONE]'));
    const result = await callStatusModel('primary', messages);
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
    const pending = callStatusModel('primary', messages);
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
      const result = await callStatusModel('primary', messages);
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
      const result = await callStatusModel('primary', messages, panel ? { panel } : {});
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
    await expect(callStatusModel('primary', messages)).rejects.toMatchObject({
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
    await expect(callStatusModel('primary', messages)).rejects.toMatchObject({
      code: 'content_filtered',
      signals: { nativeFinishReason: 'SAFETY' },
    });
    // Surplus 断流：先发 stream_incomplete 错误块再发 [DONE]
    forward.mockResolvedValueOnce(
      sse(delta('体力：'), JSON.stringify({ error: { code: 'stream_incomplete' } }), '[DONE]')
    );
    await expect(callStatusModel('primary', messages)).rejects.toMatchObject({
      code: 'stream_interrupted',
    });
    // 写满长度上限
    forward.mockResolvedValueOnce(sse(delta('体力：', 'length'), '[DONE]'));
    await expect(callStatusModel('primary', messages)).rejects.toMatchObject({ code: 'truncated' });
    // 既没有结束原因也没有 [DONE]
    forward.mockResolvedValueOnce(sse(delta('体力：')));
    await expect(callStatusModel('primary', messages)).rejects.toMatchObject({
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
