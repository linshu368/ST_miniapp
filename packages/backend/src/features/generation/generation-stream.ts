import { revealsReasoning } from './reasoning-display.js';
import { generationFailureFields, deliveryFailureFields } from './failure-diagnostics.js';
import type { SseTapResult } from './upstream.js';
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
import type { ExecutionObservation, RecoveryForward } from './generation-dispatch.js';
import { runStreamPass, type StreamPass } from './stream-pass.js';
import {
  involvesMinor,
  planRecovery,
  recentDialogue,
  recoveredResult,
  runRecovery,
  toRecoveryRules,
  unrecoveredResult,
  type RecoveryRules,
} from './stream-recovery.js';
import { readChatRecoveryConfig } from './chat-recovery-config.js';
import { recordStreamEnd } from './call-ledger.js';
/**
 * 单次聊天回复的可见正文上限（字符）。只数用户看得到的正文，不含推理。
 * 对应约 3300 token（实测 1.65 字符/可见 token）。这是产品上有意收紧的长度：近 7 天约 1.4%
 * 的正常回复会超过它（主要是 gemini-3.8-flash、deepseek-v4-pro 这类长文模型），会被截断。
 * 同时拦截模型失控（无限续写记忆栏、复读），否则只能烧到超时，单条可达 3 万字符。
 * 触顶按中断处理：finish_reason=length，不扣费，已生成的部分保留。
 */
export const CHAT_MAX_VISIBLE_CHARS = 5_400;

type StreamInput = {
  request: GenerationRequest;
  billing: ModelBillingContext;
  saveHistory: SaveHistory;
  log: GenerationLogger;
  upstreamStartedAt: number;
  hooks?: GenerationHooks;
  signal: AbortSignal;
  deliveryPersisted: Promise<void>;
  headerGenerationId: string | null;
  upstreamRes: Response;
  chargeId: string;
  observation: ExecutionObservation;
  /** 出字后兜底的上游调用；没有首字竞速的调用方不传，此时不做任何出字后兜底 */
  recover?: RecoveryForward;
};
type SettlementState = {
  settlement?: Promise<void>;
  settledResult?: SseTapResult;
  firstTokenAt: number | null;
};

function createSettleOnce(input: StreamInput, state: SettlementState) {
  const { request, billing, saveHistory, log, upstreamStartedAt, hooks, signal } = input;
  const { deliveryPersisted } = input;
  return (observed: SseTapResult): Promise<void> => {
    state.settlement ??= (async () => {
      // Surplus 响应头声明的截断已在 stream-pass 归为 stream_error，这里不再单独判断。
      let interrupted = signal.aborted
        ? { ...observed, completed: false, finishReason: 'timeout' }
        : observed;
      try {
        await deliveryPersisted;
      } catch (err) {
        log.sys.error(
          {
            err,
            event: 'llm.delivery.persistence_failed',
            historyId: request.historyId,
            ...deliveryFailureFields(err),
          },
          '生成身份确认失败，保留回复但不结算'
        );
        interrupted = {
          ...interrupted,
          completed: false,
          finishReason: 'delivery_persistence_failed',
        };
      }
      // A failed persisted claim throws here; it cannot be charged based only on local [DONE].
      state.settledResult = hooks?.onBeforeSettle
        ? await hooks.onBeforeSettle(interrupted)
        : interrupted;
      await settleStream({
        result: state.settledResult,
        request,
        billing,
        saveHistory,
        log,
        upstreamStartedAt,
        firstTokenAt: state.firstTokenAt,
      });
    })();
    return state.settlement;
  };
}

/** 用户可见的输出口：首发与出字后兜底共用，统一记首字时间与 5400 字上限。 */
function createEmitters(input: StreamInput, state: SettlementState) {
  const { request, hooks, observation } = input;
  const outputCap = new AbortController();
  let visibleChars = 0;
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
  return {
    outputCap,
    get visibleChars() {
      return visibleChars;
    },
    /** 出字后兜底重写：用户看到的是一条新回复，5400 字上限重新计 */
    reset: (): void => {
      visibleChars = 0;
    },
    // 只数可见正文：onDelta 本来就逐片段回调，这里只多一次整数累加和比较。
    content: (delta: string): void => {
      noteFirstToken(delta);
      hooks?.onDelta?.(delta);
      visibleChars += delta.length;
      if (visibleChars > CHAT_MAX_VISIBLE_CHARS && !outputCap.signal.aborted) outputCap.abort();
    },
    reasoning: !revealsReasoning(request)
      ? undefined
      : (delta: string): void => {
          noteFirstToken(delta);
          hooks?.onReasoningDelta?.(delta);
        },
  };
}

function logPrimaryEnd(input: StreamInput, pass: StreamPass, visibleChars: number): void {
  const { request, billing, log, signal } = input;
  const common = {
    historyId: request.historyId ?? null,
    provider: billing.provider,
    model: billing.providerModelId,
  };
  log.biz.info(
    {
      event: 'llm.stream.ended',
      ...common,
      stream_end: pass.end,
      visible_chars: visibleChars,
      max_gap_ms: pass.maxGapMs,
      tail_gap_ms: pass.tailGapMs,
    },
    '首发出字后的结束方式'
  );
  if (request.firstToken && request.historyId)
    recordStreamEnd({ chatHistoryId: request.historyId }, pass.end, log.sys);
  if (pass.end === 'output_cap') {
    log.sys.warn(
      {
        event: 'llm.stream.output_capped',
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        generationId: pass.result.generationId,
        visibleChars,
        limit: CHAT_MAX_VISIBLE_CHARS,
      },
      '可见正文超过上限，已中止上游'
    );
  } else if (pass.error) {
    const fields = generationFailureFields(pass.error, signal);
    log.sys[fields.failure_kind === 'user_stop' ? 'info' : 'error'](
      {
        event: 'llm.stream.failed',
        ...fields,
        err: pass.error,
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        generationId: pass.result.generationId,
      },
      'upstream stream aborted'
    );
  }
}

/** 首发读完后决定交给结算的结果：需要且能救就发一次兜底。 */
async function resolveDelivered(
  input: StreamInput,
  primary: StreamPass,
  rules: RecoveryRules,
  emit: ReturnType<typeof createEmitters>,
  dialogue: string[]
): Promise<{ result: SseTapResult; recovered: boolean }> {
  const { request, log, signal } = input;
  if (primary.end === 'output_cap')
    return {
      result: { ...primary.result, completed: false, finishReason: 'length' },
      recovered: false,
    };
  const plan = planRecovery({
    pass: primary,
    rules,
    dialogue,
    elapsedMs: request.firstToken ? performance.now() - request.firstToken.requestStartedAt : 0,
    available: Boolean(input.recover && request.firstToken),
  });
  if (!plan) return { result: primary.result, recovered: false };
  const freeZoneId = request.model.billingContext?.freeZone?.candidateId ?? null;
  // 开关关着时也记一条（info），用来看各平台 + 模型的中断与拒答量；真正想救却救不了的记 warn。
  log.biz['skip' in plan && plan.skip !== 'disabled' ? 'warn' : 'info'](
    {
      event: 'llm.recovery.triggered',
      historyId: request.historyId ?? null,
      provider: input.billing.provider,
      model: input.billing.providerModelId,
      trigger: plan.trigger,
      mode: 'mode' in plan ? plan.mode : null,
      skip_reason: 'skip' in plan ? plan.skip : null,
      visible_chars: emit.visibleChars,
      max_gap_ms: primary.maxGapMs,
    },
    'skip' in plan ? '出字后出问题，未启用兜底' : '出字后出问题，启用兜底'
  );
  if ('skip' in plan || !input.recover)
    return { result: unrecoveredResult(primary, null), recovered: false };
  const recovery = await runRecovery({
    trigger: plan.trigger,
    request,
    rules,
    forward: input.recover,
    signal,
    outputCap: emit.outputCap.signal,
    onContent: emit.content,
    // 与首发同一显示规则：不显示思考的轮次这里是 undefined，重写只认正文
    onReasoning: emit.reasoning,
    onReset: () => {
      emit.reset();
      input.hooks?.onReset?.();
    },
    ledger: request.historyId
      ? {
          chatHistoryId: request.historyId,
          lane: freeZoneId ? 'free_zone' : 'chat',
          candidateId: freeZoneId,
        }
      : null,
    log,
  });
  const recovered = Boolean(
    recovery.pass?.end === 'completed' && recovery.pass.result.content.trim()
  );
  if (input.observation.turn)
    input.observation.turn.rewrite = {
      provider: input.recover.model.provider,
      model: input.recover.model.providerModelId,
      trigger: plan.trigger,
      callEnd: recovery.callEnd,
      passEnd: recovery.pass?.end ?? null,
      httpStatus: recovery.httpStatus,
      recovered,
    };
  log.biz[recovered ? 'info' : 'warn'](
    {
      event: 'llm.recovery.completed',
      historyId: request.historyId ?? null,
      mode: plan.mode,
      fallback_model: input.recover.model.providerModelId,
      outcome: recovery.callEnd,
      http_status: recovery.httpStatus,
      first_token_ms: recovery.firstTokenMs === null ? null : Math.round(recovery.firstTokenMs),
      duration_ms: recovery.durationMs,
      added_chars: recovery.pass?.result.content.length ?? 0,
      reasoning_chars: recovery.reasoningChars,
      reset: recovery.reset,
    },
    recovered ? '出字后兜底成功' : '出字后兜底失败，按中断结算'
  );
  return recovered && recovery.pass
    ? { result: recoveredResult(primary, recovery.pass), recovered: true }
    : { result: unrecoveredResult(primary, recovery), recovered: false };
}

export async function consumeStream(input: StreamInput): Promise<GenerationResult> {
  const { request, billing, hooks, signal, headerGenerationId, upstreamRes, chargeId } = input;
  const state: SettlementState = { firstTokenAt: null };
  const settleOnce = createSettleOnce(input, state);
  const emit = createEmitters(input, state);
  const rules = toRecoveryRules(input.recover ? await readChatRecoveryConfig() : null);
  const dialogue = recentDialogue(request);
  const primary = await runStreamPass({
    body: upstreamRes.body as ReadableStream<Uint8Array>,
    signal,
    outputCap: emit.outputCap.signal,
    generationId: headerGenerationId,
    onGenerationId: request.firstToken ? undefined : hooks?.onGenerationId,
    onContent: emit.content,
    onReasoning: emit.reasoning,
    stallMs: rules.interruption?.stallMs ?? null,
    refusal: rules.refusal,
    // 拒答原文或最近对话涉及未成年人：不掐断、不重写，原样交付（不绕开供应商对未成年人内容的拒绝）。
    keepOnRefusal: (seen) => involvesMinor([seen, ...dialogue]),
    truncated: billing.provider === 'surplus' && upstreamRes.headers.get('x-si-truncated') === '1',
  });
  logPrimaryEnd(input, primary, emit.visibleChars);
  const delivered = await resolveDelivered(input, primary, rules, emit, dialogue);
  if (input.observation.turn) {
    input.observation.turn.deliveredEnd = primary.end;
    input.observation.turn.recovered = delivered.recovered;
  }
  await settleOnce(delivered.result);
  if (primary.error && !delivered.recovered && primary.end !== 'output_cap')
    hooks?.onError?.(toError(primary.error));

  const tapped = state.settledResult ?? delivered.result;
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
