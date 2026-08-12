import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationStreamDoneEvent,
  ConversationStreamEvent,
  ConversationStreamStartEvent,
} from '@miniapp/shared';
import { ConversationStreamError, streamConversationTurn } from './conversation-stream';

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

  it('重生成不带 content，打到 regenerate 路由且 body 为空对象', async () => {
    fetchMock.mockResolvedValue(sseResponse([frame(START), frame(DONE)]));

    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', ...sink.options });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/conversations/s1/regenerate');
    expect(init.body).toBe('{}');
  });

  it('发消息打到 messages 路由并带上 initData', async () => {
    fetchMock.mockResolvedValue(sseResponse([frame(START), frame(DONE)]));

    const sink = collector();
    await streamConversationTurn({ sessionId: 's1', content: '你好', ...sink.options });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/conversations/s1/messages');
    expect(init.body).toBe(JSON.stringify({ content: '你好' }));
    expect(new Headers(init.headers).get('X-Init-Data')).toBe('stub-init-data');
  });
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

    await expect(promise).rejects.toThrow('AbortError');
  });
});
