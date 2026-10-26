/**
 * backend / features / generation / upstream.ts
 *
 * 上游转发与 SSE tap。这是全仓唯一的聊天 LLM 出口（架构铁律 6），
 * 只有 features/generation/execute.ts 会调它。
 *
 * 调用方自行 drain 响应体，通过 onDelta 把增量重新编码成对话链路的 SSE 事件；
 * tap 只旁听不改字节，chunk 原样向下游输出。
 *
 * 只有见到 `data: [DONE]` 才算正常收流，这是「流中断不扣费」的唯一判据，
 * 因此终态回调必须在 flush 里完成后才放行 callback。
 */

import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  LLM_PROVIDER_CAPABILITIES,
  MAX_CONVERSATION_REASONING_LENGTH,
  type LlmModelProvider,
} from '@miniapp/shared';
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';
import { veniceFetch } from '../../platform/venice-http.js';

const LLM_UPSTREAM_URL = getLlmProviderRuntimeConfig('openrouter').baseUrl;

export const LLM_API_KEY = getLlmProviderRuntimeConfig('openrouter').apiKey;

/** OpenAI 兼容子路径，聊天生成固定打这一条 */
export const CHAT_COMPLETIONS_PATH = '/chat/completions';

export function resolveUpstreamUrl(subPath: string, baseUrl = LLM_UPSTREAM_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}${subPath}`;
}

export function resolveProviderUpstream(provider: LlmModelProvider): {
  provider: LlmModelProvider;
  url: string;
  apiKey: string;
} {
  const capability = LLM_PROVIDER_CAPABILITIES[provider];
  const runtime = getLlmProviderRuntimeConfig(provider);
  const baseUrl = runtime.baseUrl.replace(/\/+$/, '');
  return {
    provider,
    url: resolveUpstreamUrl(capability.chatCompletionsPath, baseUrl),
    apiKey: runtime.apiKey,
  };
}

/** 注入平台真实 API key 后转发。失败原样抛出，由调用方决定是 502 还是 upstream_error。 */
export async function forwardToUpstream(input: {
  url: string;
  method: string;
  body?: BodyInit | undefined;
  signal?: AbortSignal;
  apiKey?: string;
  provider?: LlmModelProvider;
}): Promise<Response> {
  const provider = input.provider ?? 'openrouter';
  const forwardHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${input.apiKey ?? LLM_API_KEY}`,
  };
  if (provider === 'openrouter') {
    forwardHeaders['HTTP-Referer'] = 'http://localhost:3000';
    forwardHeaders['X-Title'] = 'ST_miniAPP';
  }

  // Venice 本地可走 VENICE_HTTPS_PROXY；OpenRouter 等其它上游保持直连。
  if (provider === 'venice') {
    return await veniceFetch(input.url, {
      method: input.method,
      headers: forwardHeaders,
      body: input.body,
      signal: input.signal,
      duplex: 'half',
    });
  }
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
  /** OpenAI-compatible usage from the terminal chunk, when requested by the provider. */
  usage: Record<string, unknown> | null;
  /** Bounded response metadata. choices/content are deliberately excluded. */
  responseMetadata: Record<string, unknown>;
}

export type SseTap = Transform & {
  /** 流被销毁导致 flush 未触发时，调用方仍能取到已累积的状态 */
  snapshot(): SseTapResult;
};

/**
 * 边透传边解析 SSE 的 Transform。chunk 原样向下游输出，不改一个字节。
 *
 * finish_reason 只进 tap 的返回值、不影响转发内容，供收口 chat_history 与计费闸门使用。
 */
export function createSseTap(options: {
  /** 上游响应头已带 x-generation-id 时的初值 */
  generationId?: string | null;
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onGenerationId?: (generationId: string) => Promise<void>;
  onEnd: (result: SseTapResult) => void | Promise<void>;
}): SseTap {
  let generationId = options.generationId ?? null;
  let streamCompleted = false;
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let responseMetadata: Record<string, unknown> = {};
  const replyChunks: string[] = [];
  const decoder = new StringDecoder('utf8');
  let sseBuffer = '';
  let reasoningLength = 0;
  let structuredReasoningSeen = false;
  let pendingOutput: Array<{ kind: 'content' | 'reasoning'; text: string }> = [];
  const splitter = createLeadingThinkingSplitter({
    onContent: (text) => {
      replyChunks.push(text);
      pendingOutput.push({ kind: 'content', text });
    },
    onReasoning: (text) => {
      if (!structuredReasoningSeen) pendingOutput.push({ kind: 'reasoning', text });
    },
  });
  const forwardPending = (): void => {
    const output = pendingOutput;
    pendingOutput = [];
    for (const part of output) {
      if (tap.destroyed) break;
      if (part.kind === 'content') options.onDelta?.(part.text);
      else if (options.onReasoningDelta && reasoningLength < MAX_CONVERSATION_REASONING_LENGTH) {
        const visible = part.text.slice(0, MAX_CONVERSATION_REASONING_LENGTH - reasoningLength);
        reasoningLength += visible.length;
        if (visible) options.onReasoningDelta(visible);
      }
    }
  };

  const snapshot = (): SseTapResult => ({
    completed: streamCompleted,
    content: replyChunks.join(''),
    deltaCount: replyChunks.length,
    generationId,
    finishReason,
    usage,
    responseMetadata,
  });

  const consumeDataLine = async (line: string): Promise<void> => {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return;
    const firstId =
      !generationId && typeof json.id === 'string' && json.id.length > 0 ? json.id : null;
    if (firstId) generationId = firstId;
    if (json.usage && typeof json.usage === 'object' && !Array.isArray(json.usage)) {
      usage = json.usage as Record<string, unknown>;
    }
    responseMetadata = { ...responseMetadata, ...boundedResponseMetadata(json) };
    const choice = Array.isArray(json.choices) ? asRecord(json.choices[0]) : null;
    const deltaFields = asRecord(choice?.delta);
    const delta = deltaFields?.content;
    const reasoning = readExposedReasoning(deltaFields);
    if (reasoning) {
      structuredReasoningSeen = true;
      pendingOutput.push({ kind: 'reasoning', text: reasoning });
    }
    if (typeof delta === 'string') {
      if (delta.length === 0) replyChunks.push('');
      else splitter.push(delta, !structuredReasoningSeen);
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    // Snapshot received text before I/O, so cleanup retains it even if identity storage fails.
    // A database failure is not malformed SSE: propagate it through pipeline cleanup.
    if (firstId) await options.onGenerationId?.(firstId);
    forwardPending();
  };

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      // A network chunk can end halfway through a Chinese character or emoji.
      sseBuffer += decoder.write(chunk);
      const lines = sseBuffer.split('\n');
      // 保留最后一行（可能不完整），其余行处理
      sseBuffer = lines.pop() || '';

      void (async () => {
        for (const line of lines) {
          if (tap.destroyed || streamCompleted) break;
          if (line.startsWith('data:') && line.slice(5).trim() === '[DONE]') {
            splitter.finish();
            forwardPending();
            streamCompleted = true;
          } else if (line.startsWith('data:')) {
            await consumeDataLine(line);
          }
        }
      })().then(
        () => callback(null, chunk),
        (err: Error) => callback(err)
      );
    },
    flush(callback) {
      void (async () => {
        sseBuffer += decoder.end();
        if (!streamCompleted && sseBuffer.startsWith('data:')) {
          if (sseBuffer.slice(5).trim() === '[DONE]') streamCompleted = true;
          else await consumeDataLine(sseBuffer);
        }
        splitter.finish();
        forwardPending();
        await options.onEnd(snapshot());
      })().then(
        () => callback(),
        (err: Error) => callback(err)
      );
    },
  });

  return Object.assign(tap, { snapshot });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Prefer one readable representation; encrypted blocks and signatures are never exposed. */
export function readExposedReasoning(delta: Record<string, unknown> | null): string {
  if (!delta) return '';
  for (const field of ['reasoning_content', 'reasoning']) {
    if (isReadableReasoningText(delta[field])) return delta[field];
  }
  if (!Array.isArray(delta.reasoning_details)) return '';
  return delta.reasoning_details
    .flatMap((detail: unknown) => {
      const value = asRecord(detail);
      if (value?.type === 'reasoning.text' && isReadableReasoningText(value.text))
        return [value.text];
      if (value?.type === 'reasoning.summary' && isReadableReasoningText(value.summary))
        return [value.summary];
      return [];
    })
    .join('');
}

function isReadableReasoningText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().replace(/\s+/g, ' ').toLowerCase() !== '[some reasoning content is encrypted]'
  );
}

/** Only a leading provider protocol region is special; later roleplay <think> text stays literal. */
export function createLeadingThinkingSplitter(callbacks: {
  onContent: (text: string) => void;
  onReasoning: (text: string) => void;
}) {
  let phase: 'prefix' | 'reasoning' | 'content' = 'prefix';
  let pending = '';
  const opening = '<think>';
  const closing = '</think>';
  const read = (text: string, exposeReasoning: boolean): void => {
    if (phase === 'content') {
      if (text) callbacks.onContent(text);
      return;
    }
    pending += text;
    if (phase === 'prefix') {
      const candidate = pending.trimStart().toLowerCase();
      if (candidate.startsWith(opening)) {
        pending = pending.trimStart().slice(opening.length);
        phase = 'reasoning';
      } else if (opening.startsWith(candidate) && pending.length <= 256) return;
      else {
        phase = 'content';
        callbacks.onContent(pending);
        pending = '';
        return;
      }
    }
    const end = pending.toLowerCase().indexOf(closing);
    if (end >= 0) {
      if (exposeReasoning && end > 0) callbacks.onReasoning(pending.slice(0, end));
      const answer = pending.slice(end + closing.length);
      pending = '';
      phase = 'content';
      if (answer) callbacks.onContent(answer);
      return;
    }
    let suffix = Math.min(pending.length, closing.length - 1);
    while (suffix > 0 && !closing.startsWith(pending.slice(-suffix).toLowerCase())) suffix -= 1;
    const ready = pending.slice(0, pending.length - suffix);
    pending = suffix > 0 ? pending.slice(-suffix) : '';
    if (exposeReasoning && ready) callbacks.onReasoning(ready);
  };
  return {
    push: (text: string, exposeReasoning = true) => read(text, exposeReasoning),
    finish: () => {
      if (phase === 'prefix' && pending) callbacks.onContent(pending);
      else if (phase === 'reasoning' && pending) callbacks.onReasoning(pending);
      pending = '';
    },
  };
}

function boundedResponseMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const safeKeys = ['id', 'object', 'created', 'model', 'usage', 'venice_parameters'];
  return Object.fromEntries(safeKeys.flatMap((key) => (key in source ? [[key, source[key]]] : [])));
}
