/**
 * 自研对话链路的流式客户端。
 *
 * 为什么不用原来的 apiStreamClient：它按 OpenAI 风格解析 { content } 分片、认 [DONE] 哨兵、
 * 回调累积全文，且对非 2xx 只抛状态码、丢掉响应体。本链路四条都对不上——
 * 事件是 ConversationStreamEvent、终态是 done 事件、delta 是增量、
 * 而 402 的响应体里带着充值文案要用的两个金额。它已随本次改动删除。
 *
 * 契约见 packages/shared/src/api/conversations.ts。
 */

import type {
  ConversationErrorCode,
  ConversationStreamDoneEvent,
  ConversationStreamEvent,
  ConversationStreamStartEvent,
} from '@miniapp/shared';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { createLogger } from '@/lib/logger';
import { API_URL } from './client';

const log = createLogger('conversation-stream');

export interface InsufficientBalanceDetail {
  creditsRequired: number;
  creditsAvailable: number;
}

/**
 * 流式请求的失败。`code` 优先取业务错误码，取不到时为 undefined，调用方按 status 兜底。
 * `balance` 只在 402 且响应体是裸形状时有值。
 */
export class ConversationStreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ConversationErrorCode | string,
    readonly balance?: InsufficientBalanceDetail
  ) {
    super(message);
    this.name = 'ConversationStreamError';
  }
}

export interface StreamTurnOptions {
  sessionId: string;
  /** 有值 = 发消息；省略 = 重生成（后端自行判定轮次，无入参） */
  content?: string;
  signal?: AbortSignal;
  /** 上游已接受本次生成，落库后的 id 到手，可以挂占位气泡了 */
  onStart: (event: ConversationStreamStartEvent) => void;
  /** 已按帧攒批的增量文本，不是累积全文 */
  onDelta: (text: string) => void;
  onDone: (event: ConversationStreamDoneEvent) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 把非 2xx 响应翻成结构化错误。
 *
 * 两种 body 形状都要认：
 *   - 余额不足走 InsufficientBalanceErrorResponse，是 { error: { type, credits_* } } 的裸形状，
 *     没有 success 字段，两个金额是充值提示文案的输入；
 *   - 其余业务错误走标准 envelope { success: false, error: { code, message } }。
 */
async function toStreamError(response: Response): Promise<ConversationStreamError> {
  const body: unknown = await response.json().catch(() => null);
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;

  if (error) {
    const message = readString(error, 'message');

    if (readString(error, 'type') === 'insufficient_balance') {
      return new ConversationStreamError(
        message ?? '星尘余额不足',
        response.status,
        'insufficient_balance',
        {
          creditsRequired: Number(error.credits_required ?? 0),
          creditsAvailable: Number(error.credits_available ?? 0),
        }
      );
    }

    const code = readString(error, 'code');
    if (code) {
      return new ConversationStreamError(
        message ?? `请求失败（${response.status}）`,
        response.status,
        code
      );
    }
  }

  return new ConversationStreamError(`请求失败（${response.status}）`, response.status);
}

/**
 * 增量攒批：上游逐 token 吐字时，直接每片 setState 会把重渲染次数拉到 token 量级。
 * 合并到一帧一次，重渲染上限就变成刷新率。
 */
function createDeltaBatcher(onDelta: (text: string) => void) {
  const schedule: (callback: () => void) => void =
    typeof requestAnimationFrame === 'function'
      ? (callback) => {
          requestAnimationFrame(callback);
        }
      : (callback) => {
          setTimeout(callback, 16);
        };

  let pending = '';
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    if (!pending) return;
    const text = pending;
    pending = '';
    onDelta(text);
  };

  return {
    push(text: string): void {
      if (!text) return;
      pending += text;
      if (scheduled) return;
      scheduled = true;
      schedule(flush);
    },
    /** 收流前同步冲一次，保证最后一批增量不会掉在未执行的回调里 */
    flush,
  };
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 发一轮消息或重生成，把 SSE 事件分发到回调。
 *
 * 关于 abort：它只停止本地读流。后端明确不因客户端断开而终止生成（sse.ts），
 * 仍会跑到 [DONE] 并落库、照常扣费。所以 abort 之后必须让会话详情失效重取，
 * 否则用户看到的是半截内容而库里已经是完整的。
 */
export async function streamConversationTurn(options: StreamTurnOptions): Promise<void> {
  const { sessionId, content, signal, onStart, onDelta, onDone } = options;

  const path =
    content === undefined
      ? `/api/v1/conversations/${encodeURIComponent(sessionId)}/regenerate`
      : `/api/v1/conversations/${encodeURIComponent(sessionId)}/messages`;

  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Request-Id': createRequestId(),
  });
  const initData = getRawInitData();
  if (initData) headers.set(INIT_DATA_HEADER, initData);

  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(content === undefined ? {} : { content }),
    signal,
    cache: 'no-store',
  });

  if (!response.ok) throw await toStreamError(response);
  if (!response.body) {
    throw new ConversationStreamError('响应体为空', response.status, 'upstream_error');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const batcher = createDeltaBatcher(onDelta);

  let buffer = '';
  let finished = false;

  const handle = (event: ConversationStreamEvent): void => {
    switch (event.type) {
      case 'start':
        onStart(event);
        return;
      case 'delta':
        batcher.push(event.text);
        return;
      case 'done':
        // 终态之前把攒着的增量放出去，否则最后一批会晚于 done 到达渲染层
        batcher.flush();
        finished = true;
        onDone(event);
        return;
      case 'error':
        batcher.flush();
        finished = true;
        throw new ConversationStreamError(event.message, response.status, event.code);
    }
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最后一段可能是被切断的半行，留到下一个 chunk 再拼
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice('data:'.length).trim();
        if (!payload) continue;

        let event: ConversationStreamEvent;
        try {
          event = JSON.parse(payload) as ConversationStreamEvent;
        } catch {
          // 单帧解析失败不该毁掉整条流：漏一片增量远好于把已生成的内容全丢掉
          log.warn('无法解析的 SSE 帧，已跳过', payload);
          continue;
        }
        handle(event);
        if (finished) break;
      }
    }
  } finally {
    batcher.flush();
    reader.releaseLock();
    // 提前收口时主动断开，避免后端继续往一个没人读的连接里写
    if (finished) await response.body.cancel().catch(() => undefined);
  }

  if (!finished) {
    throw new ConversationStreamError('生成中断，请稍后重试', response.status, 'upstream_error');
  }
}
