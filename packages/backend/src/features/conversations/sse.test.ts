import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { createReplyStreamSink, encodeStreamEvent } from './sse.js';

/** 只实现 sink 会碰到的那几个成员，其余交给类型断言 */
class FakeRaw extends EventEmitter {
  destroyed = false;
  ended = false;
  head: { status: number; headers: Record<string, string> } | null = null;
  chunks: string[] = [];

  writeHead(status: number, headers: Record<string, string>): void {
    this.head = { status, headers };
  }
  flushHeaders(): void {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

function fakeReply(): { reply: FastifyReply; raw: FakeRaw; hijack: ReturnType<typeof vi.fn> } {
  const raw = new FakeRaw();
  const hijack = vi.fn();
  return { reply: { raw, hijack } as unknown as FastifyReply, raw, hijack };
}

describe('encodeStreamEvent', () => {
  it('每个事件一行 data:，以空行结尾', () => {
    expect(encodeStreamEvent({ type: 'delta', text: '你好' })).toBe(
      'data: {"type":"delta","text":"你好"}\n\n'
    );
  });

  it('正文里的换行不会破坏帧结构', () => {
    const encoded = encodeStreamEvent({ type: 'delta', text: '第一段\n\n第二段' });
    expect(encoded.split('\n\n')).toHaveLength(2);
  });
});

describe('createReplyStreamSink', () => {
  it('open 之前不写任何字节，opened 为 false', () => {
    const { reply, raw } = fakeReply();
    const sink = createReplyStreamSink(reply);

    sink.send({ type: 'delta', text: '不该出现' });

    expect(sink.opened).toBe(false);
    expect(raw.head).toBeNull();
    expect(raw.chunks).toEqual([]);
  });

  it('open 时接管 reply 并写出 SSE 响应头', () => {
    const { reply, raw, hijack } = fakeReply();
    const sink = createReplyStreamSink(reply);

    sink.open();

    expect(hijack).toHaveBeenCalledTimes(1);
    expect(raw.head?.status).toBe(200);
    expect(raw.head?.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    // nginx 缓冲住就没有「流式」可言了
    expect(raw.head?.headers['X-Accel-Buffering']).toBe('no');
    expect(sink.opened).toBe(true);
  });

  it('重复 open 无副作用', () => {
    const { reply, hijack } = fakeReply();
    const sink = createReplyStreamSink(reply);

    sink.open();
    sink.open();

    expect(hijack).toHaveBeenCalledTimes(1);
  });

  it('客户端断开后静默丢弃写入，且不再 end 一次', () => {
    const { reply, raw } = fakeReply();
    const sink = createReplyStreamSink(reply);
    sink.open();
    sink.send({ type: 'delta', text: '断开前' });

    raw.emit('close');
    sink.send({ type: 'delta', text: '断开后' });
    sink.close();

    expect(sink.clientGone).toBe(true);
    expect(raw.chunks).toEqual([encodeStreamEvent({ type: 'delta', text: '断开前' })]);
    expect(raw.ended).toBe(false);
  });

  it('正常收尾会 end 一次，close 幂等', () => {
    const { reply, raw } = fakeReply();
    const sink = createReplyStreamSink(reply);

    sink.open();
    sink.close();
    raw.ended = false;
    sink.close();

    expect(raw.ended).toBe(false);
  });

  it('底层 socket 已销毁时不再写入', () => {
    const { reply, raw } = fakeReply();
    const sink = createReplyStreamSink(reply);
    sink.open();

    raw.destroyed = true;
    sink.send({ type: 'delta', text: '不该出现' });

    expect(raw.chunks).toEqual([]);
  });
});
