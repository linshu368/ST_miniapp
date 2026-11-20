/**
 * 状态面板的模型调用。平台承担成本，不扣星尘；每 5 轮自动或 VIP 手动触发。
 *
 * - 主通道：Surplus 平台的 Gemini 3 Flash（gemini-3-flash-preview），复用 SURPLUS_* 配置；
 *   思考调到 none（状态更新本质是抽取与累加，不需要长思考）。供应商不认思考参数、或模型不可用时走兜底。
 * - 兜底：模型目录里的通用兜底（fallback_model_id，默认 deepseek/deepseek-v4.1-flash-1017），
 *   走 OpenRouter，优先供应商与正文首字兜底同源（resolveFallbackProviders）。
 *
 * 非流式、明确超时与响应上限；错误只带错误码，不附带 prompt 或供应商响应体。
 */
import { FIRST_TOKEN_FALLBACK_MODEL_ID, resolveFallbackProviders } from '@miniapp/shared';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';
import { forwardToUpstream, resolveProviderUpstream } from './upstream.js';

/** 主通道模型（Surplus 上的名字）。 */
export const STATUS_MODEL_PRIMARY = 'gemini-3-flash-preview';

export const STATUS_MODEL_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 131_072;
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

async function callPrimary(
  messages: StatusModelMessages,
  signal: AbortSignal
): Promise<StatusModelResult> {
  const upstream = resolveProviderUpstream('surplus', STATUS_MODEL_PRIMARY);
  if (!upstream.apiKey) throw new StatusModelError('unconfigured', 'primary');
  let response: Response;
  try {
    response = await forwardToUpstream({
      ...upstream,
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: STATUS_MODEL_PRIMARY,
        stream: false,
        temperature: TEMPERATURE,
        max_tokens: MAX_OUTPUT_TOKENS,
        reasoning: { effort: 'none' },
        messages: chatMessages(messages),
      }),
    });
  } catch {
    throw new StatusModelError(signal.aborted ? 'timeout' : 'transport', 'primary');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new StatusModelError('http_' + response.status, 'primary');
  }
  return {
    content: readContent(await readJson(response, signal, 'primary'), 'primary'),
    channel: 'primary',
    model: STATUS_MODEL_PRIMARY,
  };
}

async function callFallback(
  messages: StatusModelMessages,
  signal: AbortSignal
): Promise<StatusModelResult> {
  const { catalog } = await fetchModelCatalogSnapshot();
  const model = catalog.fallback_model_id ?? FIRST_TOKEN_FALLBACK_MODEL_ID;
  const providers = resolveFallbackProviders(catalog);
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
