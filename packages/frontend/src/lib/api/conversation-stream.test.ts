import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationStreamDoneEvent,
  ConversationStreamEvent,
  ConversationStreamStartEvent,
} from '@miniapp/shared';
import {
  ConversationStreamError,
  streamConversationTurn,
  createConversationRequestId,
  CONVERSATION_STREAM_IDLE_TIMEOUT_MS,
  CONVERSATION_STREAM_DEADLINE_MS,
} from './conversation-stream';

// 真实实现会 import @telegram-apps/sdk-react，在 node 环境下没必要拉起来
vi.mock('@/lib/telegram/auth', () => ({
  getRawInitData: () => 'stub-init-data',
  INIT_DATA_HEADER: 'X-Init-Data',
}));

const encoder = new TextEncoder();

/** 把若干原始 chunk 拼成一个响应体，用来模拟被任意切分的网络分片 */
function sseResponse(chunks: readonly string[], init?: ResponseInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

function frame(event: ConversationStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const START: ConversationStreamStartEvent = {
  type: 'start',
  turn_index: 1,
  user_message_id: 'u1',
  assistant_message_id: 'a1',
  revision: 0,
};

const DONE: ConversationStreamDoneEvent = {
  type: 'done',
  assistant_message_id: 'a1',
  status: 'complete',
  finish_reason: 'stop',
};

function collector() {
  const start: ConversationStreamStartEvent[] = [];
  const deltas: string[] = [];
  const done: ConversationStreamDoneEvent[] = [];

  return {
    start,
    deltas,
    done,
    options: {
      onStart: (event: ConversationStreamStartEvent) => start.push(event),
      onDelta: (text: string) => deltas.push(text),
      onDone: (event: ConversationStreamDoneEvent) => done.push(event),
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('streamConversationTurn — 正常流', () => {
  it('按事件分发 start / delta / done，delta 是增量而非累积全文', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame(START),
        frame({ type: 'delta', text: '今天' }),
        frame({ type: 'delta', text: '天气' }),
        frame({ type: 'delta', text: '不错' }),
        frame(DONE),
      ])
    );

    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', content: '你好', ...sink.options });

    expect(sink.start).toEqual([START]);
    expect(sink.done).toEqual([DONE]);
    // 攒批后可能合并，但拼起来必须与逐片一致，且任何一片都不是累积全文
    expect(sink.deltas.join('')).toBe('今天天气不错');
  });

  it('半行被切在 chunk 边界时能拼回来', async () => {
    const payload = frame(START) + frame({ type: 'delta', text: '被切开的内容' }) + frame(DONE);
    // 每 7 个字符切一刀，保证 data 行、JSON 字面量、结尾换行都被切断过
    const chunks: string[] = [];
    for (let i = 0; i < payload.length; i += 7) chunks.push(payload.slice(i, i + 7));
    fetchMock.mockResolvedValue(sseResponse(chunks));

    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', content: '你好', ...sink.options });

    expect(sink.start).toHaveLength(1);
    expect(sink.deltas.join('')).toBe('被切开的内容');
    expect(sink.done).toHaveLength(1);
  });

  it('无法解析的帧被跳过，不影响整条流', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame(START),
        'data: {不是合法 JSON\n\n',
        frame({ type: 'delta', text: '正常内容' }),
        frame(DONE),
      ])
    );

    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', content: '你好', ...sink.options });

    expect(sink.deltas.join('')).toBe('正常内容');
    expect(sink.done).toHaveLength(1);
  });

  it('重生成不带 content，默认开启思考', async () => {
    fetchMock.mockResolvedValue(sseResponse([frame(START), frame(DONE)]));

    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', ...sink.options });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/conversations/s1/regenerate');
    expect(JSON.parse(init.body as string)).toEqual({
      thinking_enabled: true,
      first_token_measurement: 'client_committed_v4',
    });
  });

  it('发消息打到 messages 路由并带上 initData', async () => {
    fetchMock.mockResolvedValue(sseResponse([frame(START), frame(DONE)]));

    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', content: '你好', ...sink.options });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/conversations/s1/messages');
    expect(JSON.parse(init.body as string)).toEqual({
      content: '你好',
      thinking_enabled: true,
      first_token_measurement: 'client_committed_v4',
    });
    expect(new Headers(init.headers).get('X-Init-Data')).toBe('stub-init-data');
  });

  it.each(['delta', 'reasoning'] as const)(
    'submits the first meaningful %s before an animation frame, then batches later tokens',
    async (type) => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      fetchMock.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          })
        )
      );
      const text: string[] = [];
      const received = vi.fn();
      const running = streamConversationTurn({
        sessionId: 's1',
        onStart: () => {},
        onDelta: (value) => text.push(value),
        onReasoning: (value) => text.push(value),
        onDone: () => {},
        onFirstDeltaReceived: received,
      });
      controller.enqueue(encoder.encode(frame(START) + frame({ type, text: '  ' })));
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(text).toEqual([]);
      expect(received).not.toHaveBeenCalled();

      controller.enqueue(encoder.encode(frame({ type, text: '首' }) + frame({ type, text: '后' })));
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
      expect(text).toEqual(['  首']);
      for (const callback of frames.splice(0)) callback(0);
      expect(text).toEqual(['  首', '后']);
      controller.enqueue(encoder.encode(frame(DONE)));
      controller.close();
      await running;
    }
  );

  it.each([true, false])(
    'shares the first-token flush between enabled reasoning and answer (thinking=%s)',
    async (thinkingEnabled) => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      fetchMock.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          })
        )
      );
      const calls: string[] = [];
      const running = streamConversationTurn({
        sessionId: 's1',
        thinkingEnabled,
        onStart: () => {},
        onReasoning: (text) => calls.push(`think:${text}`),
        onDelta: (text) => calls.push(`answer:${text}`),
        onDone: () => {},
      });
      controller.enqueue(
        encoder.encode(
          frame(START) +
            frame({ type: 'reasoning', text: '思' }) +
            frame({ type: 'delta', text: '答' }) +
            frame({ type: 'delta', text: '案' })
        )
      );
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(calls).toEqual(thinkingEnabled ? ['think:思'] : ['answer:答']);
      frames.shift()!(0);
      expect(calls).toEqual(
        thinkingEnabled ? ['think:思', 'answer:答案'] : ['answer:答', 'answer:案']
      );
      controller.enqueue(encoder.encode(frame(DONE)));
      controller.close();
      await running;
    }
  );
});

describe('streamConversationTurn — 流未开始的失败', () => {
  it('402 裸响应体：认出 insufficient_balance 并带出两个金额', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'Insufficient credits: have 10, need 50',
            type: 'insufficient_balance',
            credits_required: 50,
            credits_available: 10,
          },
        }),
        { status: 402 }
      )
    );

    const sink = collector();
    const error = await streamConversationTurn({
      sessionId: 's1',
      content: '你好',
      ...sink.options,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConversationStreamError);
    const streamError = error as ConversationStreamError;
    expect(streamError.status).toBe(402);
    expect(streamError.code).toBe('insufficient_balance');
    expect(streamError.balance).toEqual({ creditsRequired: 50, creditsAvailable: 10 });
  });

  it('402 标准 envelope 形状也认得出来', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'insufficient_balance', message: '星尘余额不足' },
        }),
        { status: 402 }
      )
    );

    const sink = collector();
    const error = (await streamConversationTurn({
      sessionId: 's1',
      content: '你好',
      ...sink.options,
    }).catch((e: unknown) => e)) as ConversationStreamError;

    expect(error.code).toBe('insufficient_balance');
    expect(error.message).toBe('星尘余额不足');
  });

  it('409 会话忙：错误码原样带出', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'session_busy', message: '这个会话还有一条回复正在生成，请稍后再试' },
        }),
        { status: 409 }
      )
    );

    const sink = collector();
    const error = (await streamConversationTurn({
      sessionId: 's1',
      content: '你好',
      ...sink.options,
    }).catch((e: unknown) => e)) as ConversationStreamError;

    expect(error.status).toBe(409);
    expect(error.code).toBe('session_busy');
  });

  it('响应体读不出来时退回状态码', async () => {
    fetchMock.mockResolvedValue(new Response('gateway exploded', { status: 502 }));

    const sink = collector();
    const error = (await streamConversationTurn({
      sessionId: 's1',
      content: '你好',
      ...sink.options,
    }).catch((e: unknown) => e)) as ConversationStreamError;

    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
  });
});

describe('streamConversationTurn — 流开始后的失败', () => {
  it('流内 error 事件抛出，已收到的增量不回滚', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame(START),
        frame({ type: 'delta', text: '写了一半' }),
        frame({ type: 'error', code: 'upstream_error', message: '生成中断，请稍后重试' }),
      ])
    );

    const sink = collector();
    const error = (await streamConversationTurn({
      sessionId: 's1',
      content: '你好',
      ...sink.options,
    }).catch((e: unknown) => e)) as ConversationStreamError;

    expect(error).toBeInstanceOf(ConversationStreamError);
    expect(error.code).toBe('upstream_error');
    // 半截正文必须已经交给渲染层，UI 才能保留它
    expect(sink.deltas.join('')).toBe('写了一半');
    expect(sink.done).toHaveLength(0);
  });

  it('流没等到 done 就断了，按中断处理', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([frame(START), frame({ type: 'delta', text: '半句话' })])
    );

    const sink = collector();
    const error = (await streamConversationTurn({
      sessionId: 's1',
      content: '你好',
      ...sink.options,
    }).catch((e: unknown) => e)) as ConversationStreamError;

    expect(error).toBeInstanceOf(ConversationStreamError);
    expect(error.code).toBe('upstream_error');
    expect(sink.deltas.join('')).toBe('半句话');
  });
});

describe('streamConversationTurn — abort', () => {
  it('signal 透传给 fetch，中止后抛出而不吞掉', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    });

    const sink = collector();
    const promise = streamConversationTurn({
      sessionId: 's1',
      content: '你好',
      signal: controller.signal,
      ...sink.options,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('streamConversationTurn — 有界恢复', () => {
  it('首字前 fetch 永不返回时仍有限时间结束', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const sink = collector();
    const result = streamConversationTurn({ sessionId: 's1', ...sink.options }).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(CONVERSATION_STREAM_IDLE_TIMEOUT_MS);
    expect(await result).toMatchObject({ status: 408 });
    expect(sink.done).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('首字后只有心跳，不能无限挂流；超时后忽略迟到正文', async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(
              encoder.encode(frame(START) + frame({ type: 'delta', text: '半句话' }))
            );
          },
        })
      )
    );
    const sink = collector();
    const result = streamConversationTurn({ sessionId: 's1', ...sink.options }).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(20);
    source.enqueue(encoder.encode(': heartbeat\n\n'));
    await vi.advanceTimersByTimeAsync(CONVERSATION_STREAM_IDLE_TIMEOUT_MS);
    expect(await result).toMatchObject({ status: 408 });
    expect(sink.deltas.join('')).toBe('半句话');
    expect(sink.done).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('正文持续增长但始终没有 done 时仍受总截止时间约束', async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(encoder.encode(frame(START)));
          },
        })
      )
    );
    const sink = collector();
    const result = streamConversationTurn({ sessionId: 's1', ...sink.options }).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(100_000);
    source.enqueue(encoder.encode(frame({ type: 'delta', text: '继续写' })));
    await vi.advanceTimersByTimeAsync(CONVERSATION_STREAM_DEADLINE_MS - 100_000);
    expect(await result).toMatchObject({ status: 408 });
    expect(sink.deltas.join('')).toBe('继续写');
    expect(sink.done).toHaveLength(0);
  });
});

it('调用方提供的请求 UUID 同时发送到消息/重生成 body 与跟踪 header', async () => {
  fetchMock.mockImplementation(() => Promise.resolve(sseResponse([frame(START), frame(DONE)])));
  const requestId = '11111111-1111-4111-8111-111111111111';
  for (const content of ['hello', undefined]) {
    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', content, requestId, ...sink.options });
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      ...(content ? { content } : {}),
      request_id: requestId,
      thinking_enabled: true,
      first_token_measurement: 'client_committed_v4',
    });
    expect(new Headers(init.headers).get('X-Request-Id')).toBe(requestId);
  }
});

describe('thinking stream', () => {
  it.each([true, false])(
    'counts a real thinking character as first-token reception only when enabled=%s',
    async (thinkingEnabled) => {
      fetchMock.mockResolvedValue(
        sseResponse([
          frame(START),
          frame({ type: 'reasoning', text: '  ' }),
          frame({ type: 'reasoning', text: '思' }),
          frame(DONE),
        ])
      );
      const sink = collector();
      const received = vi.fn();
      await streamConversationTurn({
        sessionId: 's1',
        thinkingEnabled,
        ...sink.options,
        onFirstDeltaReceived: received,
      });
      expect(received).toHaveBeenCalledTimes(thinkingEnabled ? 1 : 0);
      expect(sink.deltas).toEqual([]);
    }
  );

  it('flushes reasoning before the first answer and done within the same chunk', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame(START) +
          frame({ type: 'reasoning', text: '先理解' }) +
          frame({ type: 'reasoning', text: '语境' }) +
          frame({ type: 'delta', text: '你好' }) +
          frame(DONE) +
          frame({ type: 'reasoning', text: 'must ignore after done' }),
      ])
    );
    const calls: string[] = [];
    await streamConversationTurn({
      sessionId: 's1',
      onStart: () => {},
      onReasoning: (text) => calls.push(`think:${text}`),
      onDelta: (text) => calls.push(`answer:${text}`),
      onDone: () => calls.push('done'),
    });
    expect(
      calls
        .filter((value) => value.startsWith('think:'))
        .map((value) => value.slice(6))
        .join('')
    ).toBe('先理解语境');
    expect(calls.slice(calls.findIndex((value) => value.startsWith('answer:')))).toEqual([
      'answer:你好',
      'done',
    ]);
  });

  it.each(['error', 'eof'])(
    'preserves pending reasoning on %s without fabricating an answer',
    async (end) => {
      fetchMock.mockResolvedValue(
        sseResponse([
          frame(START),
          frame({ type: 'reasoning', text: '真实思考' }),
          ...(end === 'error'
            ? [frame({ type: 'error', code: 'upstream_error', message: 'failed' })]
            : []),
        ])
      );
      const sink = collector();
      const thought: string[] = [];
      await expect(
        streamConversationTurn({
          sessionId: 's1',
          ...sink.options,
          onReasoning: (text) => thought.push(text),
        })
      ).rejects.toBeInstanceOf(ConversationStreamError);
      expect(thought.join('')).toBe('真实思考');
      expect(sink.deltas).toEqual([]);
      expect(sink.done).toEqual([]);
    }
  );

  it.each(['hello', undefined])(
    'sends explicit off for send/regenerate and suppresses unexpected provider thoughts (%s)',
    async (content) => {
      fetchMock.mockResolvedValue(
        sseResponse([
          frame(START),
          frame({ type: 'reasoning', text: 'hidden' }),
          frame({ type: 'delta', text: 'visible' }),
          frame(DONE),
        ])
      );
      const sink = collector();
      const onReasoning = vi.fn();
      await streamConversationTurn({
        sessionId: 's1',
        content,
        thinkingEnabled: false,
        ...sink.options,
        onReasoning,
      });
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).thinking_enabled).toBe(false);
      expect(onReasoning).not.toHaveBeenCalled();
      expect(sink.deltas.join('')).toBe('visible');
    }
  );

  it('ignores invalid reasoning text and unknown events without exposing their payload', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame(START),
        'data: null\n\ndata: {"type":"reasoning","text":{"secret":"bad"}}\n\n',
        frame({ type: 'delta', text: 'ok' }),
        frame(DONE),
      ])
    );
    const sink = collector();
    const onReasoning = vi.fn();
    await streamConversationTurn({ sessionId: 's1', ...sink.options, onReasoning });
    expect(onReasoning).not.toHaveBeenCalled();
    expect(sink.deltas.join('')).toBe('ok');
  });

  it('reasoning counts as progress but never extends the absolute generation deadline', async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(encoder.encode(frame(START)));
          },
        })
      )
    );
    const sink = collector();
    const thought = vi.fn();
    const result = streamConversationTurn({
      sessionId: 's1',
      ...sink.options,
      onReasoning: thought,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100_000);
    source.enqueue(encoder.encode(frame({ type: 'reasoning', text: 'continuing' })));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(thought).toHaveBeenCalledWith('continuing');
    expect(sink.done).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CONVERSATION_STREAM_DEADLINE_MS - 130_000);
    expect(await result).toMatchObject({ status: 408 });
  });
});

it('randomUUID 不可用时仍生成符合 v4 格式的请求 UUID', () => {
  vi.stubGlobal('crypto', undefined);
  expect(createConversationRequestId()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});
