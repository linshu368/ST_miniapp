/**
 * backend / scripts / st-regression / mock-upstream.ts
 *
 * 假上游：一个 OpenAI 兼容的 HTTP 服务，用来替代 OpenRouter。
 *
 * 存在的理由是「上游 5xx 不扣费」和「流中断不扣费」这两条判据——对着真实 OpenRouter
 * 没法按需触发它们，只能靠运气或临时改代码，而它们恰恰是 §7.3 里最容易出事的两条。
 * 这里把三种终态变成可选参数，每条都能稳定复现。
 *
 * 接线方式是 LLM_UPSTREAM_URL 环境变量（features/generation/upstream.ts 在模块加载时读取），
 * 所以调用方必须在 import 任何后端模块之前就把它设好。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 假上游返回的完整回复正文，断言 chat_history.assistant_reply 时直接对这个常量 */
export const MOCK_REPLY_TEXT = '云层压得很低。她把伞往你这边偏了偏，没说话。';

/** 分片方式固定，保证每次跑出来的 SSE 切包一致 */
const REPLY_CHUNKS = ['云层压得很低。', '她把伞往你这边偏了偏，', '没说话。'];

export type UpstreamScenario =
  /** 200 + SSE + data: [DONE]，正常收流 */
  | 'success'
  /**
   * 200 + SSE，吐几片后**干净地**结束响应，但始终不发 [DONE]。
   * 这是 §7.3 说的「流中断」：TCP 层正常收尾，只是语义上没跑完。
   */
  | 'interrupted'
  /**
   * 200 + SSE，吐几片后直接销毁 socket。
   * 与 interrupted 的区别在 TCP 层：undici 会把它当错误抛，而不是正常 EOF，
   * 触发的是完全不同的一条代码路径。
   */
  | 'aborted'
  /** 502 + JSON 错误体 */
  | 'server_error'
  /** 200 + 非流式 JSON（ST 的非流式代理路径） */
  | 'non_stream_success';

export interface UpstreamRequestRecord {
  method: string;
  path: string;
  /** 转发时注入的平台 key，用来确认 handler 没把 ST 侧的 token 透传给上游 */
  authorization: string | null;
  body: unknown;
}

export interface MockUpstreamOptions {
  /**
   * 每个 SSE 分片之间的间隔。默认 0（一口气写完，ST 回归要的就是这个确定性）。
   *
   * M3b 回归的「客户端中途断开」那条判据需要一个真实的流式窗口：客户端要在第二、三片
   * 还没到的时候就把 socket 掐掉，才能证明后端不会跟着停。
   */
  chunkDelayMs?: number;
  /**
   * 是否在 SSE 负载里带 id 字段。
   *
   * 默认 false：带上 id 会让 chat-history-logger 认为有 generation_id，进而对**真实的**
   * openrouter.ai 发一次元数据回捞（URL 是硬编码的，mock 拦不到）。那会引入 1.5s 等待、
   * 一次外部网络调用和不稳定的落库字段，与本脚本要的确定性相冲突。
   * 需要专门验这条分支时用 --generation-id 打开。
   */
  emitGenerationId?: boolean;
}

export interface MockUpstream {
  /** 直接就是 LLM_UPSTREAM_URL 该填的值（不带尾部斜杠） */
  url: string;
  /** 收到的请求，按时间顺序。断言「402 前不碰上游」时查它的长度 */
  requests: UpstreamRequestRecord[];
  setScenario(scenario: UpstreamScenario): void;
  reset(): void;
  close(): Promise<void>;
}

function ssePayload(delta: string, emitId: boolean, finishReason: string | null): string {
  const payload: Record<string, unknown> = {
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: finishReason }],
  };
  if (emitId) payload.id = 'gen-mock-fixed-id';
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

export async function startMockUpstream(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  const emitId = options.emitGenerationId === true;
  const chunkDelayMs = Math.max(options.chunkDelayMs ?? 0, 0);
  const pause = async (): Promise<void> => {
    if (chunkDelayMs === 0) return;
    await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
  };
  let scenario: UpstreamScenario = 'success';
  const requests: UpstreamRequestRecord[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: (req.headers.authorization as string | undefined) ?? null,
        body,
      });

      if (scenario === 'server_error') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: 'mock upstream is down', type: 'server_error' } })
        );
        return;
      }

      if (scenario === 'non_stream_success') {
        const payload: Record<string, unknown> = {
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: MOCK_REPLY_TEXT } }],
        };
        if (emitId) payload.id = 'gen-mock-fixed-id';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      writeSseHead(res);

      if (scenario === 'interrupted' || scenario === 'aborted') {
        res.write(ssePayload(REPLY_CHUNKS[0] ?? '', emitId, null));
        res.write(ssePayload(REPLY_CHUNKS[1] ?? '', emitId, null));
        if (scenario === 'aborted') {
          // 销毁 socket：undici 收到的是错误而不是 EOF，tap 的 flush 永远不会触发。
          setTimeout(() => res.destroy(), 20);
        } else {
          // 正常收尾（chunked 的结束块照发），只是没有 [DONE]。tap 走 flush → onEnd。
          res.end();
        }
        return;
      }

      for (const [index, chunk] of REPLY_CHUNKS.entries()) {
        const isLast = index === REPLY_CHUNKS.length - 1;
        if (index > 0) await pause();
        if (res.destroyed) return;
        res.write(ssePayload(chunk, emitId, isLast ? 'stop' : null));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setScenario(next) {
      scenario = next;
    },
    reset() {
      requests.length = 0;
      scenario = 'success';
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** 只在 interrupted 场景成立：客户端最终看到的正文是前两片拼起来的 */
export const MOCK_PARTIAL_REPLY_TEXT = `${REPLY_CHUNKS[0] ?? ''}${REPLY_CHUNKS[1] ?? ''}`;
