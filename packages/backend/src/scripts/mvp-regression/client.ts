/**
 * backend / scripts / mvp-regression / client.ts
 *
 * 自研对话链路的 HTTP 客户端，扮演 M5 还没写出来的那个前端。
 *
 * 用 node:http 而不是 fetch，是为了「客户端中途断开」那条判据（§8.3 第 7 条）：
 * 需要在收到第 N 个 delta 之后精确地把 socket 掐掉，fetch 的 AbortController 做不到
 * 「已经收了一半、现在立刻断」这种时序控制。
 *
 * 鉴权走 MOCK_AUTH=1 的 initData 旁路（middleware/auth.ts 已有的非生产分支），
 * 这样不需要真实的 TELEGRAM_BOT_TOKEN 也能打通 requireTelegramAuth。
 */

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { ConversationStreamEvent } from '@miniapp/shared';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: T | null;
  /** JSON 响应为空数组；SSE 响应是按序解析出来的事件流 */
  events: ConversationStreamEvent[];
  /** 从 delta 事件还原出来的正文，等价于前端最终渲染的内容 */
  streamedContent: string;
  /** 客户端主动掐断了连接（模拟用户切后台 / 关页面） */
  aborted: boolean;
}

/** MOCK_AUTH=1 时 verifyTelegramInitData 只解析 user 参数，不验签 */
export function buildInitData(tgId: string, displayName = 'MVP 回归测试用户'): string {
  const user = { id: Number(tgId), first_name: displayName, username: `mvp_regr_${tgId}` };
  return `auth_date=${Math.floor(Date.now() / 1000)}&user=${encodeURIComponent(JSON.stringify(user))}`;
}

export interface RequestOptions {
  baseUrl: string;
  initData: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** 收到第 N 个 delta 事件后立刻销毁连接，用来验「客户端断开不终止后端」 */
  abortAfterDeltas?: number;
  timeoutMs?: number;
}

export async function callApi<T = unknown>(options: RequestOptions): Promise<ApiResponse<T>> {
  const url = new URL(options.path, options.baseUrl);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);

  const headers: Record<string, string> = { 'X-Init-Data': options.initData };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }

  return await new Promise<ApiResponse<T>>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let deltaCount = 0;
        let aborted = false;

        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const body = Buffer.concat(chunks).toString('utf8');
          const events = parseStreamEvents(body);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: parseJson<T>(body),
            events,
            streamedContent: events
              .filter((event) => event.type === 'delta')
              .map((event) => event.text)
              .join(''),
            aborted,
          });
        };

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (options.abortAfterDeltas === undefined) return;
          deltaCount += countDeltas(chunk.toString('utf8'));
          if (deltaCount >= options.abortAfterDeltas && !aborted) {
            aborted = true;
            req.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('aborted', finish);
        res.on('error', finish);

        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            req.destroy();
            finish();
          }, options.timeoutMs);
        }
      }
    );

    req.on('error', (error) => {
      // 主动 destroy 触发的 ECONNRESET 不是失败，已经在 finish 里收口了
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function countDeltas(chunk: string): number {
  return chunk.split('\n').filter((line) => line.includes('"type":"delta"')).length;
}

export function parseStreamEvents(body: string): ConversationStreamEvent[] {
  const events: ConversationStreamEvent[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(trimmed.slice(6)) as ConversationStreamEvent);
    } catch {
      // 半截帧（客户端中途断开时必然出现），跳过
    }
  }
  return events;
}
