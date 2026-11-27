/**
 * 会话长期记忆的压缩调用。平台承担成本，不走用户计费；只在后台 worker 中调用。
 *
 * 走 Surplus、流式：后台任务不追求速度，但卡住的卖家要尽早放弃——首段输出（思考也算）超过
 * firstOutputTimeoutMs 就中止这次调用，交给任务退避重试（Surplus 会重新选卖家）；另有 240 秒总超时。
 * DeepSeek 1017 在 Surplus 上关不掉思考，mistral 又不收 reasoning 字段，所以不发思考参数；
 * 思考只计字数，不进档案、不进日志。错误只携带错误码与标量，不附带 prompt 或供应商响应体。
 */
import {
  createSseTap,
  forwardToUpstream,
  resolveProviderUpstream,
  type SseTapResult,
} from './upstream.js';
import { surplusRouteBody, surplusRouteHeaders, type SurplusRoute } from './surplus-route.js';
import { countChars } from '../story-memory/text.js';
import { stripCodeFence } from '../story-memory/validate.js';

/** 后台任务不追求速度：DeepSeek 在 Surplus 上关不掉思考，大块章节要想 3～4 万字，给足时间 */
export const STORY_MEMORY_COMPRESS_TIMEOUT_MS = 240_000;
/**
 * 原始字节上限，只防失控：流式每个 delta 都包一层 JSON，加上思考过程，体积是正文的几十倍
 * （11-27 生产首个任务：思考 1.5 万字就超过了 1 MiB）。原始字节边读边丢，只留正文，不占内存。
 */
const MAX_RESPONSE_BYTES = 16 * 1_048_576;
/**
 * 思考也占输出 token。11-27 生产：2 万字章节的并入要想 3～4 万字，24000 时 6/8 次全花在思考上、
 * 档案一个字没写就 length 截断；成功的用了 1.7～2 万。给到 48000。
 */
const MAX_OUTPUT_TOKENS = 48_000;
const FINISH_REASONS = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'error'];

export class StoryMemoryCompressError extends Error {
  constructor(
    readonly code: string,
    readonly diagnostics: StoryMemoryCompressDiagnostics = {}
  ) {
    super('story_memory_compress_' + code);
  }
}

/** Only measured scalars: never attach the response, prompt, reasoning or provider error text. */
export interface StoryMemoryCompressDiagnostics {
  upstream_status?: number;
  upstream_request_id?: string;
  response_bytes?: number;
  max_response_bytes?: number;
  max_output_tokens?: number;
  timeout_ms?: number;
  first_output_timeout_ms?: number;
  first_output_ms?: number;
  finish_reason?: string;
  output_chars?: number;
  reasoning_chars?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface StoryMemoryCompressResult {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  diagnostics: StoryMemoryCompressDiagnostics;
}

export interface StoryMemoryCompressInput {
  /** Surplus 标准模型名 */
  model: string;
  route: SurplusRoute;
  firstOutputTimeoutMs: number;
  prompt: string;
  temperature: number;
  signal?: AbortSignal;
}

class FirstOutputTimeout extends Error {}

function readTokens(usage: Record<string, unknown> | null, key: string): number | null {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Surplus 自己的请求号（去 Surplus 后台查单用）；只取短的标识符，不取任意头内容 */
function requestId(response: Response): string | undefined {
  const value = response.headers.get('x-si-request-id') ?? response.headers.get('x-request-id');
  return value && /^[\w.:-]{1,100}$/.test(value) ? value : undefined;
}

/**
 * 边读边交给 SSE 解析；signal 中止时立刻 reject（自定义 transport 可能不响应 fetch 的中止）。
 * onOutput 在第一段非空正文或思考到达时调用。
 */
async function readStream(
  response: Response,
  signal: AbortSignal,
  diagnostics: StoryMemoryCompressDiagnostics,
  onOutput: (kind: 'content' | 'reasoning', text: string) => void
): Promise<SseTapResult> {
  if (!response.body) throw new StoryMemoryCompressError('empty_response');
  const reader = response.body.getReader();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  let ended!: (result: SseTapResult) => void;
  let failed!: (err: unknown) => void;
  const tapEnded = new Promise<SseTapResult>((resolve, reject) => {
    ended = resolve;
    failed = reject;
  });
  const tap = createSseTap({
    onDelta: (text) => onOutput('content', text),
    onReasoningDelta: (text) => onOutput('reasoning', text),
    onEnd: (result) => ended(result),
  });
  tap.on('error', failed);
  // Only the parsed result matters; drain the pass-through bytes so writes never back up.
  tap.resume();
  diagnostics.response_bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      diagnostics.response_bytes += value.byteLength;
      if (diagnostics.response_bytes > MAX_RESPONSE_BYTES)
        throw new StoryMemoryCompressError('response_too_large');
      tap.write(Buffer.from(value));
    }
    tap.end();
    return await Promise.race([tapEnded, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!tap.writableEnded) tap.destroy();
    // Cleanup must not extend the deadline if the underlying cancel hook stalls.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function errorCode(
  error: unknown,
  signals: { caller?: AbortSignal; firstOutput: AbortSignal; total: AbortSignal },
  stage: string
): string {
  if (error instanceof StoryMemoryCompressError) return error.code;
  if (signals.caller?.aborted) return 'cancelled';
  if (signals.firstOutput.aborted) return 'first_output_timeout';
  if (signals.total.aborted) return 'timeout';
  return stage;
}

export async function compressStoryMemory(
  input: StoryMemoryCompressInput
): Promise<StoryMemoryCompressResult> {
  const startedAt = performance.now();
  const total = AbortSignal.timeout(STORY_MEMORY_COMPRESS_TIMEOUT_MS);
  const firstOutput = new AbortController();
  const signal = AbortSignal.any(
    [input.signal, total, firstOutput.signal].filter((item): item is AbortSignal => !!item)
  );
  const diagnostics: StoryMemoryCompressDiagnostics = {
    max_response_bytes: MAX_RESPONSE_BYTES,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    timeout_ms: STORY_MEMORY_COMPRESS_TIMEOUT_MS,
    first_output_timeout_ms: input.firstOutputTimeoutMs,
  };
  const firstOutputTimer = setTimeout(
    () => firstOutput.abort(new FirstOutputTimeout('first_output_timeout')),
    input.firstOutputTimeoutMs
  );
  firstOutputTimer.unref();
  let reasoningChars = 0;
  const onOutput = (kind: 'content' | 'reasoning', text: string) => {
    if (kind === 'reasoning') reasoningChars += countChars(text);
    if (diagnostics.first_output_ms !== undefined || !text.trim()) return;
    diagnostics.first_output_ms = Math.round(performance.now() - startedAt);
    clearTimeout(firstOutputTimer);
  };
  let stage = 'unconfigured';
  try {
    const upstream = resolveProviderUpstream('surplus', input.model);
    signal.throwIfAborted();
    if (!upstream.apiKey) throw new StoryMemoryCompressError('unconfigured');
    stage = 'transport';
    const response = await forwardToUpstream({
      ...upstream,
      provider: 'surplus',
      method: 'POST',
      signal,
      headers: surplusRouteHeaders(input.route),
      body: JSON.stringify({
        model: input.model,
        stream: true,
        temperature: input.temperature,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: input.prompt }],
        ...surplusRouteBody(input.route),
      }),
    });
    diagnostics.upstream_status = response.status;
    const id = requestId(response);
    if (id) diagnostics.upstream_request_id = id;
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new StoryMemoryCompressError('http_' + response.status);
    }
    stage = 'invalid_response';
    const result = await readStream(response, signal, diagnostics, onOutput);
    return completedResult(result, diagnostics, reasoningChars);
  } catch (error) {
    if (reasoningChars > 0) diagnostics.reasoning_chars = reasoningChars;
    const code = errorCode(
      error,
      { caller: input.signal, firstOutput: firstOutput.signal, total },
      stage
    );
    throw new StoryMemoryCompressError(code, diagnostics);
  } finally {
    clearTimeout(firstOutputTimer);
  }
}

/** 只接受完整结束（见到 [DONE]、没有流内错误、finish_reason=stop）的档案：截断的档案会悄悄丢掉后面的板块 */
function completedResult(
  result: SseTapResult,
  diagnostics: StoryMemoryCompressDiagnostics,
  reasoningChars: number
): StoryMemoryCompressResult {
  const inputTokens = readTokens(result.usage, 'prompt_tokens');
  const outputTokens = readTokens(result.usage, 'completion_tokens');
  if (inputTokens !== null) diagnostics.input_tokens = inputTokens;
  if (outputTokens !== null) diagnostics.output_tokens = outputTokens;
  if (reasoningChars > 0) diagnostics.reasoning_chars = reasoningChars;
  diagnostics.output_chars = countChars(stripCodeFence(result.content));
  if (result.finishReason !== null) {
    diagnostics.finish_reason = FINISH_REASONS.includes(result.finishReason)
      ? result.finishReason
      : 'other';
  }
  if (!result.completed || result.streamError || result.finishReason !== 'stop') {
    throw new StoryMemoryCompressError('incomplete', diagnostics);
  }
  if (result.deltaCount === 0) throw new StoryMemoryCompressError('empty_response', diagnostics);
  return { content: result.content, inputTokens, outputTokens, diagnostics };
}
