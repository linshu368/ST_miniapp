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

  it('被拦或没写完（finish_reason 不是 stop）报 incomplete', async () => {
    forward.mockResolvedValueOnce(sse(delta('体力：', 'content_filter'), '[DONE]'));
    await expect(callStatusModel('primary', messages)).rejects.toMatchObject({
      code: 'incomplete',
    });
  });
});
