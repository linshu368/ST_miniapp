/**
 * 会话长期记忆的压缩调用。平台承担成本，不走用户计费；只在后台 worker 中调用。
 *
 * 非流式、关闭推理、明确超时与响应上限。错误只携带错误码，不附带 prompt 或供应商响应体。
 */
import { forwardToUpstream, resolveProviderUpstream } from './upstream.js';
import { countChars } from '../story-memory/text.js';
import { stripCodeFence } from '../story-memory/validate.js';

export const STORY_MEMORY_COMPRESS_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_OUTPUT_TOKENS = 12_000;

export class StoryMemoryCompressError extends Error {
  constructor(
    readonly code: string,
    readonly diagnostics: StoryMemoryCompressDiagnostics = {}
  ) {
    super('story_memory_compress_' + code);
  }
}

/** Only measured scalars: never attach the response, prompt or provider error text. */
export interface StoryMemoryCompressDiagnostics {
  upstream_status?: number;
  response_bytes?: number;
  max_response_bytes?: number;
  max_output_tokens?: number;
  timeout_ms?: number;
  finish_reason?: string;
  output_chars?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface StoryMemoryCompressResult {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  diagnostics: StoryMemoryCompressDiagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  diagnostics: StoryMemoryCompressDiagnostics
): Promise<unknown> {
  if (!response.body) throw new StoryMemoryCompressError('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  diagnostics.response_bytes = 0;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    for (;;) {
      signal.throwIfAborted();
      // Custom transports may not interrupt a stalled body when fetch's signal aborts.
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      diagnostics.response_bytes += value.byteLength;
      if (diagnostics.response_bytes > MAX_RESPONSE_BYTES)
        throw new StoryMemoryCompressError('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    // Cleanup must not extend the deadline if the underlying cancel hook stalls.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readTokens(usage: unknown, key: string): number | null {
  if (!isRecord(usage)) return null;
  const value = usage[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export async function compressStoryMemory(input: {
  model: string;
  /** OpenRouter 供应商优先顺序；为空交给默认路由 */
  preferredProviders: readonly string[];
  prompt: string;
  temperature: number;
  signal?: AbortSignal;
}): Promise<StoryMemoryCompressResult> {
  const timeout = AbortSignal.timeout(STORY_MEMORY_COMPRESS_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const diagnostics: StoryMemoryCompressDiagnostics = {
    max_response_bytes: MAX_RESPONSE_BYTES,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    timeout_ms: STORY_MEMORY_COMPRESS_TIMEOUT_MS,
  };
  let stage = 'unconfigured';
  try {
    const upstream = resolveProviderUpstream('openrouter', input.model);
    signal.throwIfAborted();
    if (!upstream.apiKey) throw new StoryMemoryCompressError('unconfigured');
    stage = 'transport';
    const response = await forwardToUpstream({
      ...upstream,
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: input.model,
        stream: false,
        temperature: input.temperature,
        max_tokens: MAX_OUTPUT_TOKENS,
        reasoning: { enabled: false, exclude: true },
        ...(input.preferredProviders.length > 0
          ? { provider: { order: [...input.preferredProviders], allow_fallbacks: true } }
          : {}),
        messages: [{ role: 'user', content: input.prompt }],
      }),
    });
    diagnostics.upstream_status = response.status;
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new StoryMemoryCompressError('http_' + response.status);
    }
    stage = 'invalid_response';
    const payload = await readJson(response, signal, diagnostics);
    if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length < 1) {
      throw new StoryMemoryCompressError('invalid_response');
    }
    const choice: unknown = payload.choices[0];
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      typeof choice.message.content !== 'string'
    ) {
      throw new StoryMemoryCompressError('invalid_response');
    }
    const inputTokens = readTokens(payload.usage, 'prompt_tokens');
    const outputTokens = readTokens(payload.usage, 'completion_tokens');
    if (inputTokens !== null) diagnostics.input_tokens = inputTokens;
    if (outputTokens !== null) diagnostics.output_tokens = outputTokens;
    diagnostics.output_chars = countChars(stripCodeFence(choice.message.content));
    diagnostics.finish_reason = [
      'stop',
      'length',
      'content_filter',
      'tool_calls',
      'function_call',
      'error',
    ].includes(String(choice.finish_reason))
      ? String(choice.finish_reason)
      : 'other';
    // A cut-off archive silently drops later sections; never accept it.
    if (choice.finish_reason !== 'stop') throw new StoryMemoryCompressError('incomplete');
    return {
      content: choice.message.content,
      inputTokens,
      outputTokens,
      diagnostics,
    };
  } catch (error) {
    const code =
      error instanceof StoryMemoryCompressError
        ? error.code
        : signal.aborted
          ? input.signal?.aborted
            ? 'cancelled'
            : 'timeout'
          : stage;
    throw new StoryMemoryCompressError(code, diagnostics);
  }
}
