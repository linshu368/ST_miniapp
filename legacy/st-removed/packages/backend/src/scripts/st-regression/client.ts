/**
 * backend / scripts / st-regression / client.ts
 *
 * 模拟 ST iframe 的 HTTP 客户端。
 *
 * ST 对 llm-proxy 而言只是个 HTTP 客户端，它发的东西全部可复现：一个 HMAC 签的
 * platformToken、四个 X-ST-* header、一个 OpenAI 兼容的 body。handler 里没有任何一处
 * 需要 iframe 真的存在，所以这条链路本地就能完整走通。
 *
 * 用 node:http 而不是 fetch，因为要读 HTTP 状态行里的 reason phrase——余额不足那条判据
 * 依赖 reply.raw.statusMessage = 'MiniApp Insufficient Credits'，而 undici 不暴露它。
 *
 * ⚠️ 本地能验的只是「后端把 statusMessage 发出去了」。它能不能活着穿过 Vercel → nginx
 *    那几跳（HTTP/2 没有 reason phrase）以及浏览器扩展认不认，只能在真实环境看。
 */

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { signPlatformToken } from '../../lib/llm-token.js';

export interface StRequestOptions {
  baseUrl: string;
  userId: string;
  characterId: string | null;
  userInput: string;
  model: string;
  presetId?: string | null;
  stream?: boolean;
  /** 额外的历史消息，模拟预设注入后的 messages 数组 */
  history?: Array<{ role: string; content: string }>;
  /**
   * 超时后拿着已收到的内容返回，而不是抛错。
   * 上游被销毁 socket 时后端不会结束下游响应（见 scenarios.ts 的 stream_aborted），
   * 没有这层超时整轮回归会一直挂着。
   */
  timeoutMs?: number;
}

export interface StResponse {
  status: number;
  /** HTTP 状态行的 reason phrase */
  statusMessage: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** 响应体里出现过 data: [DONE] */
  sawDone: boolean;
  /** 从 SSE 增量里还原出来的正文，等价于 ST 侧最终渲染的内容 */
  streamedContent: string;
  /** 响应迟迟没有结束，是被 timeoutMs 掐断的 */
  timedOut: boolean;
}

function extractStreamedContent(body: string): { content: string; sawDone: boolean } {
  let content = '';
  let sawDone = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'data: [DONE]') {
      sawDone = true;
      continue;
    }
    if (!trimmed.startsWith('data: ')) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(6)) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
    } catch {
      // 非 JSON 的 data 行，跳过
    }
  }
  return { content, sawDone };
}

/** 发一次 ST 形态的 chat completion 请求。上游断流不算错误，照常返回已收到的部分。 */
export async function sendStChatCompletion(options: StRequestOptions): Promise<StResponse> {
  const url = new URL('/api/platform/llm-proxy/v1/chat/completions', options.baseUrl);
  const token = signPlatformToken(options.userId);

  const messages = [
    ...(options.history ?? []),
    // ST 真实请求里末尾这条往往是预设注入的 post-history 指令，真正的用户输入走
    // X-ST-User-Input header。这里刻意做成不一致，用来验 handler 优先取 header。
    { role: 'user', content: '（预设注入的 post-history 指令，不应被当成用户输入）' },
  ];
  const payload = JSON.stringify({
    model: options.model,
    messages,
    stream: options.stream !== false,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    Authorization: `Bearer ${token}`,
    'X-ST-User-Input': Buffer.from(options.userInput, 'utf8').toString('base64'),
  };
  if (options.characterId) headers['X-ST-Character-Id'] = options.characterId;
  if (options.presetId) headers['X-ST-Preset-Id'] = options.presetId;

  return await new Promise<StResponse>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));

        const finish = (timedOut: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const body = Buffer.concat(chunks).toString('utf8');
          const { content, sawDone } = extractStreamedContent(body);
          resolve({
            status: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            headers: res.headers,
            body,
            sawDone,
            streamedContent: content,
            timedOut,
          });
        };

        res.on('end', () => finish(false));
        // 上游断链时下游也会 aborted，这是 stream_aborted 场景要观察的形态之一。
        res.on('aborted', () => finish(false));
        res.on('error', () => finish(false));

        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            req.destroy();
            finish(true);
          }, options.timeoutMs);
        }
      }
    );

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    req.write(payload);
    req.end();
  });
}
