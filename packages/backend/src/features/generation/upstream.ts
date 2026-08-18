/**
 * backend / features / generation / upstream.ts
 *
 * 上游转发与 SSE tap（M3a）。搬自 routes/llm-proxy.ts 原第 529~565 行与 640~761 行，
 * 解析逻辑逐行对照原 handler，行为零变化。
 *
 * 两条链路共用同一出口，但消费方式不同：
 *   - ST 链路把 tap 挂在 pipe 上，边透传给 iframe 边累积（响应体逐字节原样转发）；
 *   - 自研链路自行 drain，通过 onDelta 把增量重新编码成自研 SSE 事件。
 *
 * 只有见到 `data: [DONE]` 才算正常收流，这是「流中断不扣费」的唯一判据，
 * 因此终态回调必须在 flush 里完成后才放行 callback。
 */

import { Transform } from 'node:stream';

const LLM_UPSTREAM_URL = process.env.LLM_UPSTREAM_URL || 'https://openrouter.ai/api/v1';

export const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

/** OpenAI 兼容子路径，自研链路固定打这一条 */
export const CHAT_COMPLETIONS_PATH = '/chat/completions';

export function resolveUpstreamUrl(subPath: string): string {
  return `${LLM_UPSTREAM_URL}${subPath}`;
}

/** 注入平台真实 API key 后转发。失败原样抛出，由调用方决定是 502 还是 upstream_error。 */
export async function forwardToUpstream(input: {
  url: string;
  method: string;
  body?: BodyInit | undefined;
  signal?: AbortSignal;
}): Promise<Response> {
  const forwardHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLM_API_KEY}`,
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'ST_miniAPP',
  };

  return await fetch(input.url, {
    method: input.method,
    headers: forwardHeaders,
    body: input.body,
    signal: input.signal,
    // @ts-expect-error Node 18+ fetch supports duplex
    duplex: 'half',
  });
}

export interface SseTapResult {
  /** 见到 `data: [DONE]` 才为 true；false 即流中断，不扣费 */
  completed: boolean;
  content: string;
  /** 收到的 delta 条数。区分「一个 delta 都没有」和「delta 全是空串」，前者才落 NULL */
  deltaCount: number;
  generationId: string | null;
  finishReason: string | null;
}

export type SseTap = Transform & {
  /** 流被销毁导致 flush 未触发时，调用方仍能取到已累积的状态 */
  snapshot(): SseTapResult;
};

/**
 * 边透传边解析 SSE 的 Transform。chunk 原样向下游输出，不改一个字节。
 *
 * finish_reason 是原 handler 未捕获的字段，这里顺带记下来供自研链路收口 chat_history；
 * 它只进 tap 的返回值，不影响转发内容，对 ST 链路无任何可观测差异。
 */
export function createSseTap(options: {
  /** 上游响应头已带 x-generation-id 时的初值 */
  generationId?: string | null;
  onDelta?: (delta: string) => void;
  onEnd: (result: SseTapResult) => void | Promise<void>;
}): SseTap {
  let generationId = options.generationId ?? null;
  let streamCompleted = false;
  let finishReason: string | null = null;
  const replyChunks: string[] = [];
  let sseBuffer = '';

  const snapshot = (): SseTapResult => ({
    completed: streamCompleted,
    content: replyChunks.join(''),
    deltaCount: replyChunks.length,
    generationId,
    finishReason,
  });

  const consumeDataLine = (line: string) => {
    try {
      const json = JSON.parse(line.slice(6));
      if (!generationId && typeof json?.id === 'string') {
        generationId = json.id;
      }
      const choice = json?.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string') {
        replyChunks.push(delta);
        options.onDelta?.(delta);
      }
      if (typeof choice?.finish_reason === 'string') {
        finishReason = choice.finish_reason;
      }
    } catch {
      // non-JSON data line or incomplete JSON, skip
    }
  };

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      // 保留最后一行（可能不完整），其余行处理
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          streamCompleted = true;
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        consumeDataLine(line);
      }

      callback(null, chunk);
    },
    flush(callback) {
      // 处理 buffer 中剩余的最后一行
      if (sseBuffer.trim() === 'data: [DONE]') {
        streamCompleted = true;
      } else if (sseBuffer.startsWith('data: ')) {
        consumeDataLine(sseBuffer);
      }

      void (async () => {
        await options.onEnd(snapshot());
      })().finally(() => callback());
    },
  });

  return Object.assign(tap, { snapshot });
}
