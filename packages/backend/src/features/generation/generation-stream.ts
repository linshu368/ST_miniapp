/**
 * 流式消费阶段：SSE tap、首字记录、读完整个流后的一次性结算，以及流终态判断。
 */

import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import type { GenerationSettlementEntry } from './settle.js';
import type { FreeQuotaReservation } from './quota.js';
import { createSseTap, type SseTapResult } from './upstream.js';
import { toError, type GenerationRun, type SaveHistory } from './generation-run.js';
import type { GenerationLogger, GenerationRequest, GenerationResult } from './types.js';

interface StreamInput {
  body: NonNullable<Response['body']>;
  headerGenerationId: string | null;
  saveHistory: SaveHistory;
  upstreamStartedAt: number;
}

/** 读流期间 tap 回调与结算共用的状态。 */
interface StreamState {
  settlement: Promise<void> | undefined;
  settledResult: SseTapResult | undefined;
  firstTokenAt: number | null;
}

/**
 * 读完整个流再结算：客户端断开不终止上游，本函数自行 drain 到 [DONE] 再落库，
 * 用户切后台回来仍能看到完整回复。
 */
export async function consumeStreamingResponse(
  run: GenerationRun,
  input: StreamInput
): Promise<GenerationResult> {
  const { request, hooks, log, signal, observation, chargeId } = run;
  const state: StreamState = {
    settlement: undefined,
    settledResult: undefined,
    firstTokenAt: null,
  };
  const settle = (observed: SseTapResult) => settleOnce(run, state, input, observed);
  let firstTokenSeen = false;
  const noteFirstToken = (text: string): void => {
    if (!firstTokenSeen && text.trim()) {
      firstTokenSeen = true;
      state.firstTokenAt = Date.now();
      if (observation.directDispatched)
        observation.firstTokenMs = performance.now() - observation.directDispatchedAt;
      hooks?.onFirstToken?.();
    }
  };
  const tap = createSseTap({
    generationId: input.headerGenerationId,
    onGenerationId: request.firstToken ? undefined : hooks?.onGenerationId,
    onReasoningDelta:
      request.thinkingEnabled === false
        ? undefined
        : (delta) => {
            noteFirstToken(delta);
            hooks?.onReasoningDelta?.(delta);
          },
    onDelta: (delta) => {
      noteFirstToken(delta);
      hooks?.onDelta?.(delta);
    },
    onEnd: settle,
  });

  try {
    await pipeline(
      Readable.fromWeb(input.body as import('stream/web').ReadableStream),
      tap,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      { signal }
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
    await settle({ ...partial, completed: false });
    const actual = state.settledResult ?? partial;
    hooks?.onError?.(toError(err));
    return run.finish({
      status: 'stream_interrupted',
      content: actual.content,
      generationId: actual.generationId,
      finishReason: actual.finishReason,
      chargeId,
      modelId: run.billing.modelId,
      modelOpenRouterId: run.billing.openRouterModelId,
    });
  }

  const tapped = state.settledResult ?? tap.snapshot();
  return run.finish({
    status:
      hasCompletedReply(tapped) && (tapped.finishReason === 'stop' || tapped.finishReason === null)
        ? 'success'
        : 'stream_interrupted',
    content: tapped.content,
    generationId: tapped.generationId,
    finishReason: tapped.finishReason,
    chargeId,
    modelId: run.billing.modelId,
    modelOpenRouterId: run.billing.openRouterModelId,
  });
}

/** 2xx 但没有正文属于 empty：不扣费，并给前端一个可重试的异常终态。 */
export async function settleEmptyStream(
  run: GenerationRun,
  headerGenerationId: string | null,
  saveHistory: SaveHistory
): Promise<GenerationResult> {
  await run.releaseReservation();
  saveHistory({
    assistant_reply: null,
    status: 'stream_interrupted',
    upstream_status: null,
    generation_id: headerGenerationId,
    finish_reason: null,
  });
  return run.finish(
    run.failed({
      status: 'stream_interrupted',
      generationId: headerGenerationId,
      chargeId: run.chargeId,
    })
  );
}

/**
 * The flush path and pipeline error path share one settlement promise. In particular,
 * a deadline during a slow CAS/quota finalize must never trigger another settlement.
 */
function settleOnce(
  run: GenerationRun,
  state: StreamState,
  input: StreamInput,
  observed: SseTapResult
): Promise<void> {
  const { request, hooks, log, signal } = run;
  state.settlement ??= (async () => {
    let interrupted = signal.aborted
      ? { ...observed, completed: false, finishReason: 'timeout' }
      : observed;
    try {
      try {
        await run.deliveryPersisted;
      } catch (err) {
        log.sys.error(
          { err, event: 'llm.delivery.persistence_failed', historyId: request.historyId },
          '生成身份确认失败，保留回复但不结算'
        );
        interrupted = {
          ...interrupted,
          completed: false,
          finishReason: 'delivery_persistence_failed',
        };
      }
      state.settledResult = hooks?.onBeforeSettle
        ? await hooks.onBeforeSettle(interrupted, run.releaseReservation)
        : interrupted;
    } catch (err) {
      // A failed persisted claim cannot be charged based only on locally observed [DONE].
      await run.releaseReservation();
      throw err;
    }
    await settleStream({
      result: state.settledResult,
      request,
      billing: run.billing,
      reservation: run.reservation,
      saveHistory: input.saveHistory,
      log,
      upstreamStartedAt: input.upstreamStartedAt,
      firstTokenAt: state.firstTokenAt,
    });
  })();
  return state.settlement;
}

/** Only generation completion; actual delivery/billing eligibility is decided separately. */
export function hasCompletedReply(result: Pick<SseTapResult, 'completed' | 'content'>) {
  return result.completed && result.content.trim().length > 0;
}

/** 只有 OpenRouter 明确确认自然结束后才能最终扣费。 */
export function isBillableReply(
  result: Pick<SseTapResult, 'completed' | 'content' | 'finishReason'>
) {
  return hasCompletedReply(result) && result.finishReason === 'stop';
}

/**
 * 流终态：完整交付与扣费终态分开判断。finish_reason 暂缺时保留免费额度预留，
 * 让 chat history 同步任务拿到 OpenRouter 的真实终态后再消费或释放。
 */
export async function settleStream(input: {
  result: SseTapResult;
  request: GenerationRequest;
  billing: ModelBillingContext;
  reservation: FreeQuotaReservation;
  saveHistory: SaveHistory;
  log: GenerationLogger;
  upstreamStartedAt: number;
  firstTokenAt: number | null;
}): Promise<void> {
  const { result, request, billing, reservation, saveHistory, log } = input;
  const delivered = hasCompletedReply(result);
  const billable = isBillableReply(result);
  const waitingForFinishReason =
    billing.provider === 'openrouter' && delivered && result.finishReason === null;
  if (!waitingForFinishReason) {
    await reservation.finalize(billable);
  }

  if (delivered && (result.finishReason === 'stop' || result.finishReason === null)) {
    log.biz.info(
      {
        event: 'llm.generation.completed',
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        provider: billing.provider,
        model: billing.providerModelId,
        generationId: result.generationId,
        replyChars: result.content.length,
      },
      waitingForFinishReason ? 'LLM 回复已完整交付，等待计费终态' : 'LLM 生成完成'
    );
    saveHistory({
      assistant_reply: result.content,
      status: 'success',
      upstream_status: null,
      generation_id: result.generationId,
      finish_reason: result.finishReason,
      provider_response: providerResponse(input),
    });
    return;
  }

  log.biz.warn(
    {
      event: 'llm.generation.interrupted',
      userId: request.userId,
      sessionId: request.sessionId ?? null,
      provider: billing.provider,
      model: billing.providerModelId,
      generationId: result.generationId,
    },
    result.finishReason === 'user_cancelled'
      ? 'user stopped generation; settling the accepted quote'
      : 'generation produced an incomplete or empty reply, skipping deduction'
  );
  saveHistory({
    assistant_reply: result.deltaCount > 0 ? result.content : null,
    status: 'stream_interrupted',
    upstream_status: null,
    generation_id: result.generationId,
    finish_reason: result.finishReason,
    provider_response: providerResponse(input),
  });
}

function providerResponse(input: {
  result: SseTapResult;
  billing: ModelBillingContext;
  upstreamStartedAt: number;
  firstTokenAt: number | null;
}): GenerationSettlementEntry['provider_response'] {
  if (input.billing.provider !== 'venice') return undefined;
  return {
    usage: input.result.usage,
    responseMetadata: input.result.responseMetadata,
    latencyMs:
      input.firstTokenAt === null
        ? null
        : Math.max(0, input.firstTokenAt - input.upstreamStartedAt),
    generationTimeMs: Math.max(0, Date.now() - input.upstreamStartedAt),
  };
}
