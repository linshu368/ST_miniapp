/**
 * 状态面板的模型调用。平台承担成本，不扣星尘；每 3 轮自动或 VIP 手动触发。
 *
 * 两个模型都由运营平台的 status_memory_model_config 配（每次调用现读；没配或配坏用默认值并记 warn），
 * 通道和参数固定在这里。状态栏和记忆栏共用这一套通道；记忆栏首发模型可单独配（memory_primary_model）。
 *
 * - 主通道：Surplus（默认 Gemini 3 Flash，gemini-3-flash-preview），复用 SURPLUS_* 配置，不设价格下限；
 *   思考调到 none（状态更新本质是抽取与累加，不需要长思考）。走流式，从发请求起 4 秒内没出第一个正文字
 *   就立刻放弃、转兜底（用户定：Gemini 卡住不等）；报错、被拦、没写完也直接转兜底。
 * - 兜底：OpenRouter（默认 deepseek/deepseek-v4-flash），不跟正文首字兜底（模型目录的 fallback_model_id）走：
 *   状态栏、记忆栏兜底比例高，用更便宜的模型（用户 11-23 定）。
 *   模型目录 fallback_provider_routes 里给这个模型配了供应商就按它排，没配由 OpenRouter 自己选。
 *
 * 首发流式、兜底非流式，都有明确超时与响应上限；错误只带错误码（没写完时细分原因，见 unfinishedCode）
 * 和原始结束原因，不附带 prompt 或供应商响应体。
 */
import {
  DEFAULT_STATUS_MEMORY_MODEL_CONFIG,
  STATUS_MEMORY_MODEL_CONFIG_KEY,
  StatusMemoryModelConfigSchema,
  resolveFallbackProviders,
  statusMemoryPrimaryModel,
  type StatusMemoryModelConfig,
  type StatusMemoryPanel,
} from '@miniapp/shared';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';
import { observation } from '../../platform/observability/runtime.js';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';
import { createSseTap, forwardToUpstream, resolveProviderUpstream } from './upstream.js';

/** 运营没配模型时的主通道模型（Surplus 上的名字）。 */
export const STATUS_MODEL_PRIMARY = DEFAULT_STATUS_MEMORY_MODEL_CONFIG.primary_model;
/** 读运营配置的时限：读不到就用默认模型，不拖慢这次更新。 */
const MODEL_CONFIG_READ_MS = 2_000;

export const STATUS_MODEL_TIMEOUT_MS = 30_000;
/** 主通道首字时限：从发请求起算，过了还没出第一个正文字就转兜底。 */
export const STATUS_PRIMARY_FIRST_TOKEN_MS = 4_000;
const MAX_RESPONSE_BYTES = 131_072;
/** 流式多了每个分片的外壳，上限放宽。 */
const MAX_STREAM_BYTES = 1_000_000;
const MAX_OUTPUT_TOKENS = 3_000;
const TEMPERATURE = 0.3;

/**
 * Surplus 主通道按模型限定供应商。Surplus 不限定时按价格路由，会落到 dashscope-cn：
 * 它的内容审核会把记忆栏这类内容写到一半掐断（stream_error / data_inspection_failed，
 * 11-26 实测同一批 60 份真实记忆记录：dashscope-cn 68% 断流，mistral 0%）。
 * 供应商口径同畅聊（只用 trusted 渠道且屏蔽 dashscope-cn，v4.1 实际由 mistral 承接）；
 * 不在表里的模型（如 Gemini）不限定，行为不变。白名单渠道不可用时报 http 错误，照常转兜底。
 */
const SURPLUS_PROVIDER_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'deepseek-v4.1-flash-1017': ['mistral'],
};

export type StatusModelChannel = 'primary' | 'fallback';

/** 没完整结束时的原始信号，只进日志用于核对归类（不含正文）。 */
export interface UnfinishedSignals {
  /** 见到结束标记 [DONE]（非流式回复按已收全处理） */
  completed: boolean;
  finishReason: string | null;
  /** 供应商原始结束原因，如 Gemini 的 SAFETY / PROHIBITED_CONTENT */
  nativeFinishReason?: string | null;
  /** 流里错误块的错误码，如 Surplus 断流时的 stream_incomplete */
  streamError?: string | null;
}

export class StatusModelError extends Error {
  constructor(
    readonly code: string,
    readonly channel: StatusModelChannel,
    readonly signals?: UnfinishedSignals
  ) {
    super(`status_bar_model_${channel}_${code}`);
  }
}

/** 供应商原始结束原因里表示"内容审核拦截"的写法（Gemini / OpenAI 系）。 */
const BLOCKED_NATIVE = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION|content_filter/i;
/** 流里错误块表示"流断了"的写法（Surplus 断流先发 stream_incomplete 再发 [DONE]）。 */
const INTERRUPTED_STREAM_ERROR = /incomplete|interrupt|disconnect|terminated/i;

/**
 * 没完整结束（不是"收到 [DONE] 且 finish_reason=stop"）时细分原因，按优先级取第一个命中：
 * - truncated：写满 max_tokens 被截断（finish_reason=length）
 * - content_filtered：被内容审核拦截（content_filter，或原始结束原因是 SAFETY 等；finish_reason=error 时靠它区分）
 * - stream_interrupted：流中断（错误块是 stream_incomplete 这类，或既没有结束原因也没有 [DONE]）
 * - stream_error：上游中途报错（finish_reason=error 或其他错误块）
 * - missing_done：finish_reason=stop 但没收到 [DONE]（内容可能其实是完整的）
 * - unfinished_other：其他结束原因
 */
export function unfinishedCode(s: UnfinishedSignals): string {
  if (s.finishReason === 'length') return 'truncated';
  if (s.finishReason === 'content_filter' || BLOCKED_NATIVE.test(s.nativeFinishReason ?? ''))
    return 'content_filtered';
  if (s.streamError && INTERRUPTED_STREAM_ERROR.test(s.streamError)) return 'stream_interrupted';
  if (s.finishReason === 'error' || s.streamError) return 'stream_error';
  if (!s.finishReason && !s.completed) return 'stream_interrupted';
  if (s.finishReason === 'stop' && !s.completed) return 'missing_done';
  return 'unfinished_other';
}

const readString = (value: unknown) => (typeof value === 'string' ? value.slice(0, 64) : null);

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
  if (choice.finish_reason !== 'stop') {
    const signals: UnfinishedSignals = {
      completed: true,
      finishReason: readString(choice.finish_reason),
      nativeFinishReason: readString(choice.native_finish_reason),
      streamError: isRecord(choice.error) ? (readString(choice.error.code) ?? 'error') : null,
    };
    throw new StatusModelError(unfinishedCode(signals), channel, signals);
  }
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

/** 每次调用现读（状态栏、记忆栏几轮才调一次，不缓存）；读不到用默认值，配坏了用默认值并记 warn。 */
async function readModels(signal: AbortSignal): Promise<StatusMemoryModelConfig> {
  const entry = await fetchRuntimeConfigEntry(
    STATUS_MEMORY_MODEL_CONFIG_KEY,
    AbortSignal.any([signal, AbortSignal.timeout(MODEL_CONFIG_READ_MS)])
  );
  if (!entry) return DEFAULT_STATUS_MEMORY_MODEL_CONFIG;
  const parsed = StatusMemoryModelConfigSchema.safeParse(entry.value);
  if (parsed.success) return parsed.data;
  observation.emit(
    'status_memory_model.config_invalid',
    'engine.config',
    {
      outcome: 'degraded',
      outcome_known: false,
      resource: STATUS_MEMORY_MODEL_CONFIG_KEY,
      config_version: entry.version,
    },
    'warn'
  );
  return DEFAULT_STATUS_MEMORY_MODEL_CONFIG;
}

async function callPrimary(
  model: string,
  messages: StatusModelMessages,
  signal: AbortSignal
): Promise<StatusModelResult> {
  const upstream = resolveProviderUpstream('surplus', model);
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
          model,
          stream: true,
          temperature: TEMPERATURE,
          max_tokens: MAX_OUTPUT_TOKENS,
          reasoning: { effort: 'none' },
          ...(SURPLUS_PROVIDER_ALLOWLIST[model]
            ? { provider: SURPLUS_PROVIDER_ALLOWLIST[model] }
            : {}),
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
    // 只接受完整结束的回复：被截断、被拦、流中断都转兜底；原因细分见 unfinishedCode
    if (!result.completed || result.finishReason !== 'stop') {
      const signals: UnfinishedSignals = {
        completed: result.completed,
        finishReason: result.finishReason,
        nativeFinishReason: result.nativeFinishReason ?? null,
        streamError: result.streamError ?? null,
      };
      throw new StatusModelError(unfinishedCode(signals), 'primary', signals);
    }
    const content = result.content.trim();
    if (!content) throw new StatusModelError('empty_content', 'primary');
    return { content, channel: 'primary', model };
  } finally {
    clearTimeout(timer);
  }
}

async function callFallback(
  model: string,
  messages: StatusModelMessages,
  signal: AbortSignal
): Promise<StatusModelResult> {
  const { catalog } = await fetchModelCatalogSnapshot();
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

/**
 * 调一次指定通道；超时 30 秒，外部信号（请求取消）一并生效。
 * panel 只影响首发选哪个模型（记忆栏可单独配），兜底两者共用。
 */
export async function callStatusModel(
  channel: StatusModelChannel,
  messages: StatusModelMessages,
  options: { panel?: StatusMemoryPanel; signal?: AbortSignal } = {}
): Promise<StatusModelResult> {
  const timeout = AbortSignal.timeout(STATUS_MODEL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const models = await readModels(signal);
    return channel === 'primary'
      ? await callPrimary(
          statusMemoryPrimaryModel(models, options.panel ?? 'status'),
          messages,
          signal
        )
      : await callFallback(models.fallback_model, messages, signal);
  } catch (error) {
    if (error instanceof StatusModelError) throw error;
    throw new StatusModelError(signal.aborted ? 'timeout' : 'unexpected', channel);
  }
}
