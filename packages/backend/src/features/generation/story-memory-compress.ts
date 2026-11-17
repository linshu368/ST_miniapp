/**
 * 会话长期记忆的压缩调用。平台承担成本，不走用户计费；只在后台 worker 中调用。
 *
 * 非流式、关闭推理、明确超时与响应上限。错误只携带错误码，不附带 prompt 或供应商响应体。
 */
import { forwardToUpstream, resolveProviderUpstream } from './upstream.js';

export const STORY_MEMORY_COMPRESS_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_OUTPUT_TOKENS = 12_000;

export class StoryMemoryCompressError extends Error {
  constructor(readonly code: string) {
    super('story_memory_compress_' + code);
  }
}

export interface StoryMemoryCompressResult {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new StoryMemoryCompressError('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new StoryMemoryCompressError('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
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
  let stage = 'unconfigured';
  try {
    const upstream = resolveProviderUpstream('openrouter', input.model);
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
    if (!response.ok) {
      await response.body?.cancel();
      throw new StoryMemoryCompressError('http_' + response.status);
    }
    stage = 'invalid_response';
    const payload = await readJson(response, signal);
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
    // A cut-off archive silently drops later sections; never accept it.
    if (choice.finish_reason !== 'stop') throw new StoryMemoryCompressError('incomplete');
    return {
      content: choice.message.content,
      inputTokens: readTokens(payload.usage, 'prompt_tokens'),
      outputTokens: readTokens(payload.usage, 'completion_tokens'),
    };
  } catch (error) {
    if (error instanceof StoryMemoryCompressError) throw error;
    throw new StoryMemoryCompressError(signal.aborted ? 'timeout' : stage);
  }
}
