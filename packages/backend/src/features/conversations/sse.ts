/**
 * backend / features / conversations / sse.ts
 *
 * 自研对话链路的 SSE 出口（M3b）。
 *
 * 抽成 sink 接口而不是让编排层直接拿 FastifyReply，是为了两件事：
 *   1. 编排层（generate.ts）能在没有 HTTP 上下文的情况下被单测；
 *   2. 「响应头写没写出去」这个状态只有一处真相——它决定失败走 HTTP 状态码还是流内事件。
 *
 * 两条纪律：
 *   - 响应头一旦写出，本次生成就只能以 200 + 流内事件收场（方案 §8.2）。open() 因此
 *     推迟到 M3a 的 onStreamOpen（上游已 2xx）才调用。
 *   - 客户端断开不终止后端流程（§5.6）：断开后写入静默丢弃，execute 继续跑到 [DONE] 并落库。
 */

import type { FastifyReply } from 'fastify';
import type { ConversationStreamEvent } from '@miniapp/shared';

export interface ConversationStreamSink {
  /** 响应头已写出。为 false 时调用方仍可改用 HTTP 状态码 + JSON 错误体 */
  readonly opened: boolean;
  /** 客户端已断开。后端不因此停止生成，只是不再往外写 */
  readonly clientGone: boolean;
  /** 写出 SSE 响应头。重复调用无副作用 */
  open(): void;
  send(event: ConversationStreamEvent): void;
  close(): void;
}

export function encodeStreamEvent(event: ConversationStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function createReplyStreamSink(reply: FastifyReply): ConversationStreamSink {
  let opened = false;
  let closed = false;
  let clientGone = false;

  // 'close' 在正常收尾时也会触发，此时 closed 已为 true，不会误判成客户端断开。
  reply.raw.on('close', () => {
    clientGone = true;
  });

  const writable = (): boolean => !closed && !clientGone && !reply.raw.destroyed;

  return {
    get opened() {
      return opened;
    },
    get clientGone() {
      return clientGone;
    },
    open() {
      if (opened) return;
      opened = true;
      // 交出 reply 的所有权，之后由本 sink 独占裸响应，Fastify 不再尝试序列化任何东西。
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx 默认会缓冲代理响应，缓冲住就没有「流式」可言了
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();
    },
    send(event) {
      if (!opened || !writable()) return;
      reply.raw.write(encodeStreamEvent(event));
    },
    close() {
      if (!opened || closed) return;
      const shouldEnd = writable();
      closed = true;
      if (shouldEnd) reply.raw.end();
    },
  };
}
