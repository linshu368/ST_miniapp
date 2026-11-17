import { Readable, Writable } from 'node:stream';
import { revealsReasoning } from './reasoning-display.js';
import { pipeline } from 'node:stream/promises';
import { createSseTap, type SseTapResult } from './upstream.js';
import type { FreeQuotaReservation } from './quota.js';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import {
  settleStream,
  toError,
  hasCompletedReply,
  type SaveHistory,
} from './generation-settlement.js';
import type {
  GenerationRequest,
  GenerationHooks,
  GenerationLogger,
  GenerationResult,
} from './types.js';
import type { ExecutionObservation } from './generation-dispatch.js';
/**
 * 单次聊天回复的可见正文上限（字符）。只数用户看得到的正文，不含推理。
 * 对应约 4500 token（实测 1.65 字符/可见 token）；近 7 天 3.7 万条成功回复里只有 20 条
 * （0.05%）的可见 token 超过 4500。
 * 模型偶发失控（无限续写记忆栏、复读）时靠它提前掐断，而不是烧到超时，单条可达 3 万字符。
 * 触顶按中断处理：finish_reason=length，不扣费，已生成的部分保留。
 */
export const CHAT_MAX_VISIBLE_CHARS = 7_400;

type StreamInput = {
  request: GenerationRequest;
  billing: ModelBillingContext;
  reservation: FreeQuotaReservation;
  saveHistory: SaveHistory;
  log: GenerationLogger;
  upstreamStartedAt: number;
  hooks?: GenerationHooks;
  signal: AbortSignal;
  deliveryPersisted: Promise<void>;
  releaseReservation: () => Promise<void>;
  headerGenerationId: string | null;
  upstreamRes: Response;
  chargeId: string;
  observation: ExecutionObservation;
};
type SettlementState = {
  settlement?: Promise<void>;
  settledResult?: SseTapResult;
  firstTokenAt: number | null;
};

function createSettleOnce(input: StreamInput, state: SettlementState) {
  const {
    request,
    billing,
    reservation,
    saveHistory,
    log,
    upstreamStartedAt,
    hooks,
    signal,
    deliveryPersisted,
    releaseReservation,
    upstreamRes,
  } = input;
  return (observed: SseTapResult): Promise<void> => {
    state.settlement ??= (async () => {
      let interrupted = signal.aborted
        ? { ...observed, completed: false, finishReason: 'timeout' }
        : observed;
      // Surplus can signal a provider deadline independently of its finish_reason.
      if (billing.provider === 'surplus' && upstreamRes.headers.get('x-si-truncated') === '1')
        interrupted = { ...interrupted, completed: false, finishReason: 'upstream_truncated' };
      try {
        try {
          await deliveryPersisted;
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
          ? await hooks.onBeforeSettle(interrupted, releaseReservation)
          : interrupted;
      } catch (err) {
        // A failed persisted claim cannot be charged based only on locally observed [DONE].
        await releaseReservation();
        throw err;
      }
      await settleStream({
        result: state.settledResult,
        request,
        billing,
        reservation,
        saveHistory,
        log,
        upstreamStartedAt,
        firstTokenAt: state.firstTokenAt,
      });
    })();
    return state.settlement;
  };
}

export async function consumeStream(input: StreamInput): Promise<GenerationResult> {
  const {
    request,
    billing,
    log,
    hooks,
    signal,
    headerGenerationId,
    upstreamRes,
    chargeId,
    observation,
  } = input;
  const state: SettlementState = { firstTokenAt: null };
  const settleOnce = createSettleOnce(input, state);
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
  // 只数可见正文：onDelta 本来就逐片段回调，这里只多一次整数累加和比较。
  const outputCap = new AbortController();
  let visibleChars = 0;
  const tap = createSseTap({
    generationId: headerGenerationId,
    onGenerationId: request.firstToken ? undefined : hooks?.onGenerationId,
    onReasoningDelta: !revealsReasoning(request)
      ? undefined
      : (delta) => {
          noteFirstToken(delta);
          hooks?.onReasoningDelta?.(delta);
        },
    onDelta: (delta) => {
      noteFirstToken(delta);
      hooks?.onDelta?.(delta);
      visibleChars += delta.length;
      if (visibleChars > CHAT_MAX_VISIBLE_CHARS && !outputCap.signal.aborted) outputCap.abort();
    },
    onEnd: settleOnce,
  });

  try {
    await pipeline(
      Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream),
      tap,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      { signal: AbortSignal.any([signal, outputCap.signal]) }
    );
  } catch (err) {
    // 流被上游或网络打断时 flush 不触发，终态要在这里补齐，否则预留的免费轮会一直挂着
    const partial = tap.snapshot();
    // 用户取消/超时同时发生时仍按原有口径处理；只有单纯触顶才算输出超限。
    const outputCapped = outputCap.signal.aborted && !signal.aborted;
    if (outputCapped) {
      log.sys.warn(
        {
          event: 'llm.stream.output_capped',
          userId: request.userId,
          sessionId: request.sessionId ?? null,
          generationId: partial.generationId,
          visibleChars,
          limit: CHAT_MAX_VISIBLE_CHARS,
        },
        '可见正文超过上限，已中止上游'
      );
    } else {
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
    }
    await settleOnce({
      ...partial,
      completed: false,
      ...(outputCapped ? { finishReason: 'length' } : {}),
    });
    const actual = state.settledResult ?? partial;
    if (!outputCapped) hooks?.onError?.(toError(err));
    return {
      status: 'stream_interrupted',
      content: actual.content,
      generationId: actual.generationId,
      finishReason: actual.finishReason,
      chargeId,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
    };
  }

  const tapped = state.settledResult ?? tap.snapshot();
  return {
    status:
      hasCompletedReply(tapped) && (tapped.finishReason === 'stop' || tapped.finishReason === null)
        ? 'success'
        : 'stream_interrupted',
    content: tapped.content,
    generationId: tapped.generationId,
    finishReason: tapped.finishReason,
    chargeId,
    modelId: billing.modelId,
    modelOpenRouterId: billing.openRouterModelId,
  };
}
