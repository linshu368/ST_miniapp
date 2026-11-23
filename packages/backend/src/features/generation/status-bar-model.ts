/**
 * 状态面板的模型调用。平台承担成本，不扣星尘；每 3 轮自动或 VIP 手动触发。
 *
 * - 主通道：Surplus 平台的 Gemini 3 Flash（gemini-3-flash-preview），复用 SURPLUS_* 配置，不设价格下限；
 *   思考调到 none（状态更新本质是抽取与累加，不需要长思考）。走流式，从发请求起 4 秒内没出第一个正文字
 *   就立刻放弃、转兜底（用户定：Gemini 卡住不等）；报错、被拦、没写完也直接转兜底。
 * - 兜底：OpenRouter 上的 deepseek/deepseek-v4-flash，固定在这里，不跟正文首字兜底（模型目录的
 *   fallback_model_id）走：状态栏、记忆栏兜底比例高，用更便宜的模型（用户 11-23 定）。
 *   模型目录 fallback_provider_routes 里给这个模型配了供应商就按它排，没配由 OpenRouter 自己选。
 *   状态栏和记忆栏共用这一套通道。
 *
 * 非流式、明确超时与响应上限；错误只带错误码，不附带 prompt 或供应商响应体。
 */
import { resolveFallbackProviders } from '@miniapp/shared';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';
import { createSseTap, forwardToUpstream, resolveProviderUpstream } from './upstream.js';

/** 主通道模型（Surplus 上的名字）。 */
export const STATUS_MODEL_PRIMARY = 'gemini-3-flash-preview';
/** 兜底模型（OpenRouter 上的名字）。 */
export const STATUS_MODEL_FALLBACK = 'deepseek/deepseek-v4-flash';

export const STATUS_MODEL_TIMEOUT_MS = 30_000;
/** 主通道首字时限：从发请求起算，过了还没出第一个正文字就转兜底。 */
export const STATUS_PRIMARY_FIRST_TOKEN_MS = 4_000;
const MAX_RESPONSE_BYTES = 131_072;
/** 流式多了每个分片的外壳，上限放宽。 */
const MAX_STREAM_BYTES = 1_000_000;
const MAX_OUTPUT_TOKENS = 3_000;
const TEMPERATURE = 0.3;

export type StatusModelChannel = 'primary' | 'fallback';

export class StatusModelError extends Error {
  constructor(
    readonly code: string,
    readonly channel: StatusModelChannel
  ) {
    super(`status_bar_model_${channel}_${code}`);
  }
}

export interface StatusModelMessages {
  system: string;
  user: string;
}

export interface StatusModelResult {
  content: string;
  channel: StatusModelChannel;
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  channel: StatusModelChannel
): Promise<unknown> {
  if (!response.body) throw new StatusModelError('empty_response', channel);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new StatusModelError('response_too_large', channel);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 只接受完整结束（finish_reason=stop）的回复：被截断的状态栏会丢后面的分区。 */
function readContent(payload: unknown, channel: StatusModelChannel): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length < 1)
    throw new StatusModelError('invalid_response', channel);
  const choice: unknown = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string')
    throw new StatusModelError('invalid_response', channel);
  if (choice.finish_reason !== 'stop') throw new StatusModelError('incomplete', channel);
  const content = choice.message.content.trim();
  if (!content) throw new StatusModelError('empty_content', channel);
  return content;
}

function chatMessages(messages: StatusModelMessages) {
  return [
    { role: 'system', content: messages.system },
    { role: 'user', content: messages.user },
  ];
}

/** 逐块读上游流，超过上限就中止（防供应商异常回超大内容）。 */
async function* boundedStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new StatusModelError('response_too_large', 'primary');
      yield chunk.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function callPrimary(
  messages: StatusModelMessages,
  signal: AbortSignal
): Promise<StatusModelResult> {
  const upstream = resolveProviderUpstream('surplus', STATUS_MODEL_PRIMARY);
  if (!upstream.apiKey) throw new StatusModelError('unconfigured', 'primary');
  // 首字计时：第一个正文字到了就停表；到点还没字就中止这次请求。
  const firstToken = new AbortController();
  const timer = setTimeout(() => firstToken.abort(), STATUS_PRIMARY_FIRST_TOKEN_MS);
  const attempt = AbortSignal.any([signal, firstToken.signal]);
  let gotToken = false;
  const abortCode = (fallback: string) =>
    !gotToken && firstToken.signal.aborted
      ? 'first_token_timeout'
      : signal.aborted
        ? 'timeout'
        : fallback;
  try {
    let response: Response;
    try {
      response = await forwardToUpstream({
        ...upstream,
        method: 'POST',
        signal: attempt,
        body: JSON.stringify({
          model: STATUS_MODEL_PRIMARY,
          stream: true,
          temperature: TEMPERATURE,
          max_tokens: MAX_OUTPUT_TOKENS,
          reasoning: { effort: 'none' },
          messages: chatMessages(messages),
        }),
      });
    } catch {
      throw new StatusModelError(abortCode('transport'), 'primary');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new StatusModelError('http_' + response.status, 'primary');
    }
    if (!response.body) throw new StatusModelError('empty_response', 'primary');
    const tap = createSseTap({
      onDelta: (text) => {
        if (gotToken || !text) return;
        gotToken = true;
        clearTimeout(timer);
      },
      onEnd: () => undefined,
    });
    try {
      await pipeline(
        Readable.from(boundedStream(response.body)),
        tap,
        new Writable({ write: (_chunk, _encoding, next) => next() }),
        { signal: attempt }
      );
    } catch (error) {
      if (error instanceof StatusModelError) throw error;
      throw new StatusModelError(abortCode('transport'), 'primary');
    }
    const result = tap.snapshot();
    // 只接受完整结束的回复：被截断、被拦（content_filter 等）都转兜底
    if (!result.completed || result.finishReason !== 'stop')
      throw new StatusModelError('incomplete', 'primary');
    const content = result.content.trim();
    if (!content) throw new StatusModelError('empty_content', 'primary');
    return { content, channel: 'primary', model: STATUS_MODEL_PRIMARY };
  } finally {
    clearTimeout(timer);
  }
}

async function callFallback(
  messages: StatusModelMessages,
  signal: AbortSignal
): Promise<StatusModelResult> {
  const { catalog } = await fetchModelCatalogSnapshot();
  const model = STATUS_MODEL_FALLBACK;
  const providers = resolveFallbackProviders({
    fallback_model_id: model,
    fallback_provider_routes: catalog.fallback_provider_routes,
  });
  const upstream = resolveProviderUpstream('openrouter', model);
  if (!upstream.apiKey) throw new StatusModelError('unconfigured', 'fallback');
  let response: Response;
  try {
    response = await forwardToUpstream({
      ...upstream,
      method: 'POST',
      signal,
      body: JSON.stringify({
        model,
        stream: false,
        temperature: TEMPERATURE,
        max_tokens: MAX_OUTPUT_TOKENS,
        reasoning: { enabled: false, exclude: true },
        ...(providers ? { provider: { order: [...providers], allow_fallbacks: true } } : {}),
        messages: chatMessages(messages),
      }),
    });
  } catch {
    throw new StatusModelError(signal.aborted ? 'timeout' : 'transport', 'fallback');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new StatusModelError('http_' + response.status, 'fallback');
  }
  return {
    content: readContent(await readJson(response, signal, 'fallback'), 'fallback'),
    channel: 'fallback',
    model,
  };
}

/** 调一次指定通道；超时 30 秒，外部信号（请求取消）一并生效。 */
export async function callStatusModel(
  channel: StatusModelChannel,
  messages: StatusModelMessages,
  callerSignal?: AbortSignal
): Promise<StatusModelResult> {
  const timeout = AbortSignal.timeout(STATUS_MODEL_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    return channel === 'primary'
      ? await callPrimary(messages, signal)
      : await callFallback(messages, signal);
  } catch (error) {
    if (error instanceof StatusModelError) throw error;
    throw new StatusModelError(signal.aborted ? 'timeout' : 'unexpected', channel);
  }
}
