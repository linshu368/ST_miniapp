/**
 * backend / features / generation / execute.ts
 *
 * 自研链路的生成出口（M3a）。把本模块的四段能力串成 GenerationService：
 *   免费额度预留 → 定档扣费额与余额预检 → 上游转发与 SSE tap → 终态落库实扣。
 *
 * 与 ST 链路共用 quota / precheck / upstream / chat-history-logger 四个模块，
 * 因此计费口径、chat_history 字段、charge_id 幂等语义在切换前后完全一致。
 *
 * 与 ST 链路的两处刻意差异，都只作用于自研链路：
 *   1. 请求体由 messages + sampling 现场构造，而不是透传 ST 的 OpenAI 请求外壳；
 *   2. promptCaching 打开时注入 Anthropic 的 cache_control 断点（决策 11）。
 *
 * 客户端断开不终止上游：本函数自行 drain 到 [DONE] 再落库，用户切后台回来仍能看到完整回复。
 *
 * 免费额度预留失败、钱包查询失败会原样抛出，调用方按 500 处理——与 ST 链路同判据。
 * 上游侧的失败（连不上 / 非 2xx / 流中断）不抛出，统一从 GenerationResult.status 收口。
 */

import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  getModelBillingContext,
  getPricingConfig,
  type ModelBillingContext,
} from '../../platform/model-tiers.js';
import { saveChatHistory, type ChatHistoryEntry } from '../../lib/chat-history-logger.js';
import { createLogger } from '../../lib/logger.js';
import { reserveCharacterFreeQuota, type FreeQuotaReservation } from './quota.js';
import { checkWalletBalance, resolveBillingPlan, type BillingPlan } from './precheck.js';
import {
  CHAT_COMPLETIONS_PATH,
  createSseTap,
  forwardToUpstream,
  resolveUpstreamUrl,
  type SseTapResult,
} from './upstream.js';
import { applyPromptCaching, type UpstreamMessage } from './prompt-caching.js';
import type {
  GenerationHooks,
  GenerationLogger,
  GenerationRequest,
  GenerationResult,
  GenerationService,
} from './types.js';

/** 一次生成里只有这四个字段随终态变化，其余 chat_history 字段全程固定。 */
type HistoryOutcome = Pick<
  ChatHistoryEntry,
  'assistant_reply' | 'status' | 'upstream_status' | 'generation_id'
>;

type SaveHistory = (outcome: HistoryOutcome) => void;

function buildUpstreamBody(request: GenerationRequest): Record<string, unknown> {
  const messages: UpstreamMessage[] = request.promptCaching
    ? applyPromptCaching(request.messages, request.model.openRouterModelId)
    : request.messages.map((message) => ({ role: message.role, content: message.content }));

  return {
    model: request.model.openRouterModelId,
    messages,
    stream: request.stream,
    // v1 恒为空对象（引擎不消费预设、不传采样参数），留着是为了后续接入预设采样参数时不改这里
    ...request.sampling,
  };
}

export async function execute(
  request: GenerationRequest,
  hooks?: GenerationHooks,
  log: GenerationLogger = createLogger('generation')
): Promise<GenerationResult> {
  const chargeId = randomUUID();
  const pricing = await getPricingConfig();
  const billing = await getModelBillingContext(request.model.openRouterModelId, pricing.markup);

  const finish = (result: GenerationResult): GenerationResult => {
    hooks?.onDone?.(result);
    return result;
  };
  const failed = (overrides: Partial<GenerationResult> = {}): GenerationResult => ({
    status: 'upstream_error',
    content: '',
    generationId: null,
    finishReason: null,
    chargeId: null,
    modelId: billing.modelId,
    modelOpenRouterId: billing.openRouterModelId,
    ...overrides,
  });

  const reservation = await reserveCharacterFreeQuota({
    chargeId,
    userId: request.userId,
    characterId: request.characterId,
    billing,
    log,
  });

  const plan = resolveBillingPlan({
    chargeId,
    billing,
    effectiveModelMarkup: reservation.effectiveModelMarkup,
    pricing,
    log,
  });

  const precheck = await checkWalletBalance({
    userId: request.userId,
    requiredAmount: plan.fixedDeduction.amount,
    openRouterModelId: billing.openRouterModelId,
    log,
  });
  if (!precheck.ok) {
    await reservation.finalize(false);
    return finish({
      status: 'insufficient_balance',
      content: '',
      generationId: null,
      finishReason: null,
      chargeId: null,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
      balance: {
        creditsRequired: precheck.creditsRequired,
        creditsAvailable: precheck.creditsAvailable,
      },
    });
  }

  const saveHistory = createHistoryWriter({ request, billing, plan, log });

  let upstreamRes: Response;
  try {
    upstreamRes = await forwardToUpstream({
      url: resolveUpstreamUrl(CHAT_COMPLETIONS_PATH),
      method: 'POST',
      body: JSON.stringify(buildUpstreamBody(request)),
    });
  } catch (err) {
    // 连不上上游时 ST 链路也不落 chat_history（没有 upstream_status 可记），这里保持一致
    await reservation.finalize(false);
    log.sys.error(
      {
        event: 'llm.upstream.error',
        err,
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        model: billing.openRouterModelId,
      },
      'upstream request failed'
    );
    hooks?.onError?.(toError(err));
    return finish(failed());
  }

  // 上游非 2xx → 不扣费，记录失败
  if (!upstreamRes.ok) {
    await reservation.finalize(false);
    const detail = await upstreamRes.text().catch(() => '');
    log.sys.error(
      {
        event: 'llm.upstream.rejected',
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        model: billing.openRouterModelId,
        upstreamStatus: upstreamRes.status,
      },
      'upstream rejected generation'
    );
    saveHistory({
      assistant_reply: null,
      status: 'upstream_error',
      upstream_status: upstreamRes.status,
      generation_id: null,
    });
    hooks?.onError?.(new Error(`upstream ${upstreamRes.status}: ${detail.slice(0, 200)}`));
    return finish(failed({ upstreamStatus: upstreamRes.status }));
  }

  // 过了这一行就不会再有 HTTP 状态码级别的失败，调用方可以安全地写出响应头。
  hooks?.onStreamOpen?.();

  const headerGenerationId = upstreamRes.headers.get('x-generation-id');

  if (!request.stream) {
    return finish(
      await consumeNonStream({
        request,
        upstreamRes,
        billing,
        chargeId,
        reservation,
        headerGenerationId,
        saveHistory,
        hooks,
        log,
      })
    );
  }

  if (!upstreamRes.body) {
    // 2xx 但没有 body：按空回复的正常收流处理，与 ST 链路一致
    await reservation.finalize(true);
    saveHistory({
      assistant_reply: null,
      status: 'success',
      upstream_status: null,
      generation_id: headerGenerationId,
    });
    return finish({
      status: 'success',
      content: '',
      generationId: headerGenerationId,
      finishReason: null,
      chargeId,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
    });
  }

  let firstTokenSeen = false;
  const tap = createSseTap({
    generationId: headerGenerationId,
    onDelta: (delta) => {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        hooks?.onFirstToken?.();
      }
      hooks?.onDelta?.(delta);
    },
    onEnd: (result) => settleStream({ result, request, billing, reservation, saveHistory, log }),
  });

  try {
    await pipeline(
      Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream),
      tap,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      })
    );
  } catch (err) {
    // 流被上游或网络打断时 flush 不触发，终态要在这里补齐，否则预留的免费轮会一直挂着
    const partial = tap.snapshot();
    log.sys.error(
      {
        event: 'llm.stream.failed',
        err,
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        generationId: partial.generationId,
      },
      'upstream stream aborted'
    );
    await settleStream({ result: partial, request, billing, reservation, saveHistory, log });
    hooks?.onError?.(toError(err));
    return finish({
      status: 'stream_interrupted',
      content: partial.content,
      generationId: partial.generationId,
      finishReason: partial.finishReason,
      chargeId,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
    });
  }

  const tapped = tap.snapshot();
  return finish({
    status: tapped.completed ? 'success' : 'stream_interrupted',
    content: tapped.content,
    generationId: tapped.generationId,
    finishReason: tapped.finishReason,
    chargeId,
    modelId: billing.modelId,
    modelOpenRouterId: billing.openRouterModelId,
  });
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** chat_history 的固定字段一次绑定，终态只补那四个会变的。 */
function createHistoryWriter(input: {
  request: GenerationRequest;
  billing: ModelBillingContext;
  plan: BillingPlan;
  log: GenerationLogger;
}): SaveHistory {
  const { request, billing, plan, log } = input;
  return (outcome) => {
    saveChatHistory(
      {
        user_id: request.userId,
        model: billing.openRouterModelId,
        ...plan.snapshot,
        user_input: request.userInput,
        history: request.messages,
        character_id: request.characterId,
        preset_id: request.presetId ?? null,
        session_id: request.sessionId ?? null,
        ...outcome,
      },
      log
    );
  };
}

/** 流终态：免费额度终结 + chat_history 落库与实扣。只有见到 [DONE] 才算成功。 */
async function settleStream(input: {
  result: SseTapResult;
  request: GenerationRequest;
  billing: ModelBillingContext;
  reservation: FreeQuotaReservation;
  saveHistory: SaveHistory;
  log: GenerationLogger;
}): Promise<void> {
  const { result, request, billing, reservation, saveHistory, log } = input;
  await reservation.finalize(result.completed);

  if (result.completed) {
    log.biz.info(
      {
        event: 'llm.generation.completed',
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        model: billing.openRouterModelId,
        generationId: result.generationId,
        replyChars: result.content.length,
      },
      'LLM 生成完成'
    );
    saveHistory({
      assistant_reply: result.content,
      status: 'success',
      upstream_status: null,
      generation_id: result.generationId,
    });
    return;
  }

  log.biz.warn(
    {
      event: 'llm.generation.interrupted',
      userId: request.userId,
      sessionId: request.sessionId ?? null,
      model: billing.openRouterModelId,
      generationId: result.generationId,
    },
    'stream ended without [DONE], skipping deduction'
  );
  saveHistory({
    assistant_reply: result.deltaCount > 0 ? result.content : null,
    status: 'stream_interrupted',
    upstream_status: null,
    generation_id: result.generationId,
  });
}

/** 非流式生成。MVP 的对话路径全走流式，这条分支只是让出口对 stream=false 也完整。 */
async function consumeNonStream(input: {
  request: GenerationRequest;
  upstreamRes: Response;
  billing: ModelBillingContext;
  chargeId: string;
  reservation: FreeQuotaReservation;
  headerGenerationId: string | null;
  saveHistory: SaveHistory;
  hooks?: GenerationHooks;
  log: GenerationLogger;
}): Promise<GenerationResult> {
  const { request, upstreamRes, billing, chargeId, reservation, saveHistory, hooks, log } = input;
  let generationId = input.headerGenerationId;

  let responseBody: string;
  try {
    responseBody = await upstreamRes.text();
  } catch (err) {
    await reservation.finalize(false);
    log.sys.error(
      { event: 'llm.upstream.body_read_failed', err, userId: request.userId },
      'failed to read non-streaming upstream response'
    );
    hooks?.onError?.(toError(err));
    return {
      status: 'upstream_error',
      content: '',
      generationId,
      finishReason: null,
      chargeId: null,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
    };
  }

  let assistantReply: string | null = null;
  let finishReason: string | null = null;
  let responseParsed = false;
  try {
    const parsed = JSON.parse(responseBody);
    responseParsed = true;
    if (!generationId && typeof parsed?.id === 'string') generationId = parsed.id;
    const choice = parsed?.choices?.[0];
    if (typeof choice?.message?.content === 'string') assistantReply = choice.message.content;
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
  } catch {
    log.sys.warn(
      { event: 'llm.upstream.invalid_non_stream_response', userId: request.userId },
      'successful upstream response was not valid JSON'
    );
  }

  if (!responseParsed) {
    await reservation.finalize(false);
    saveHistory({
      assistant_reply: null,
      status: 'upstream_error',
      upstream_status: upstreamRes.status,
      generation_id: generationId,
    });
    return {
      status: 'upstream_error',
      content: '',
      generationId,
      finishReason: null,
      chargeId: null,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
      upstreamStatus: upstreamRes.status,
    };
  }

  await reservation.finalize(true);
  saveHistory({
    assistant_reply: assistantReply,
    status: 'success',
    upstream_status: null,
    generation_id: generationId,
  });
  if (assistantReply) {
    hooks?.onFirstToken?.();
    hooks?.onDelta?.(assistantReply);
  }
  return {
    status: 'success',
    content: assistantReply ?? '',
    generationId,
    finishReason,
    chargeId,
    modelId: billing.modelId,
    modelOpenRouterId: billing.openRouterModelId,
  };
}

export const generationService: GenerationService = { execute };
