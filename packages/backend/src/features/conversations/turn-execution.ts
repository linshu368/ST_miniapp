/**
 * 一轮生成在开轮之后的执行阶段：构造 execute 请求与 hooks、执行后收口和失败收口。
 * 编排顺序见 generate.ts 的 runConversationTurn；共享状态见 turn-scope.ts。
 * 本文件只拆出各阶段，不改变 await 与副作用顺序。
 */
import { diagnoseRichReplyProtocol } from '@miniapp/shared';
import type { RequestLogger } from '../../lib/logger.js';
import type { buildPrompt } from '../engine/index.js';
import type { InstructionSlotModes } from '../engine/types.js';
import { FirstTokenDeadlineError } from '../generation/first-token-fallback.js';
import type { GenerationHooks, GenerationRequest, GenerationResult } from '../generation/index.js';
import { GenerationCleanupPendingError } from '../generation/types.js';
import type { SseTapResult } from '../generation/upstream.js';
import { TextPostprocessRepository } from '../text-postprocess/repository.js';
import { appendActiveDelivery } from './active-delivery.js';
import type { ConversationTurnOutcome } from './generate.js';
import type { ConversationPreparationTiming } from './preparation-timing.js';
import { historyRecords } from './turn-repositories.js';
import type { TurnScope } from './turn-scope.js';

/** 取消、用户停止或超时已由别的写入方落到这一轮；收口必须沿用它的原因，不能覆盖成成功或失败。 */
function isExternallyInterrupted(finishReason: string | null): boolean {
  return (
    finishReason === 'cancelled' || finishReason === 'user_cancelled' || finishReason === 'timeout'
  );
}

export function buildGenerationRequest(
  scope: TurnScope,
  prompt: ReturnType<typeof buildPrompt>,
  executionPreparation: GenerationRequest['preparation']
): GenerationRequest {
  const { chargeId, userId, session, model, turn, requestStartedAt, control, observations } = scope;
  const { thinkingEnabled, primaryAttemptId } = scope;
  return {
    plannedChargeId: chargeId,
    preparation: executionPreparation,
    userId,
    characterId: session.character_id,
    model,
    messages: prompt.messages,
    sampling: prompt.sampling,
    userInput: turn.userInput,
    sessionId: session.id,
    historyId: turn.historyId,
    stream: true,
    firstToken: {
      primaryAttemptId,
      requestStartedAt,
      deferPersistence: true,
      onReady: () => {
        control.markReady();
      },
      store: {
        prepareFallback: (attempt, triggeredMs) =>
          observations.prepareFallback(turn.historyId, attempt, triggeredMs),
        // Each attempt carries its own bounded terminal diagnostic. Winner metadata
        // follows normal settlement; the cancelled loser never needs a second fetch.
        observe: (attempt) => observations.observe(turn.historyId, attempt),
        selectDelivery: (attempt) => observations.selectDelivery(turn.historyId, attempt),
      },
    },
    thinkingEnabled,
    revealReasoning: scope.revealReasoning,
    signal: control.signal,
    // Anthropic prompt cache 的 cache_control 断点，配合双水位线泄洪制造稳定前缀
    promptCaching: true,
  };
}

/** 可见增量：先校验首字截止，再写交付预览、首字检查点，最后发给浏览器。 */
function createDeltaEmitter(scope: TurnScope) {
  const { control, requestStartedAt, policy, turn, observations, sink } = scope;
  return (type: 'delta' | 'reasoning', text: string): void => {
    if (control.readyMs === null && performance.now() - requestStartedAt >= policy.deadlineMs) {
      control.recordFirstTokenTimeout();
      control.abort(new FirstTokenDeadlineError());
    }
    control.signal.throwIfAborted();
    appendActiveDelivery(turn.historyId, type, text);
    if (text.trim() && !control.checkpoint) {
      const readyMs = control.markReady();
      control.checkpoint = observations
        .checkpoint(turn.historyId, turn.revision, readyMs, type, text)
        .catch(control.observationError);
    }
    // Timing belongs to Grafana; delivery preview above is the required recovery fact.
    sink.send({ type, text });
  };
}

export function createExecutionHooks(
  scope: TurnScope,
  prompt: ReturnType<typeof buildPrompt>,
  preparation: ConversationPreparationTiming
): GenerationHooks {
  const { control, observations, observationInput, chargeId, turn } = scope;
  const { emitStart, revealReasoning } = scope;
  const emitVisibleDelta = createDeltaEmitter(scope);
  return {
    onBeforeDispatch: async (snapshot) => {
      control.signal.throwIfAborted();
      await observations.begin({ ...observationInput, snapshot, history: prompt.messages });
      control.signal.throwIfAborted();
      preparation.ready();
      emitStart();
    },
    onBeforeReserve: async (reservedChargeId) => {
      control.signal.throwIfAborted();
      if (reservedChargeId !== chargeId) throw new Error('生成计费身份发生变化');
    },
    onBeforeSettle: async (observed, releaseReservation) => {
      await control.checkpoint;
      const success =
        observed.completed &&
        observed.content.trim().length > 0 &&
        (observed.finishReason === 'stop' || observed.finishReason === null);
      if (!success) await releaseReservation();
      let row = await historyRecords().finalizeTurn({
        historyId: turn.historyId,
        content: observed.content,
        status: success ? 'success' : 'stream_interrupted',
        finishReason: observed.finishReason,
      });
      if (row.llm_finish_reason === 'user_cancelled') control.stopFirstTokenTimer();
      if (row.status === 'streaming') {
        // A cancel marker won the completion CAS; free quota must be released before
        // terminal acknowledgement lets the user regenerate with their original quota.
        await releaseReservation();
        row = await historyRecords().finalizeTurn({
          historyId: turn.historyId,
          content: observed.content,
          status: 'stream_interrupted',
          finishReason: row.llm_finish_reason ?? 'timeout',
        });
      }
      return normalizePersistedOutcome(observed, row.status, row.llm_finish_reason);
    },
    onStreamOpen: emitStart,
    onDelta: (text) => emitVisibleDelta('delta', text),
    onReasoningDelta: (text) => {
      if (revealReasoning) emitVisibleDelta('reasoning', text);
    },
  };
}

/** execute 返回后的收口：以库里最终状态为准写终态，未开流时映射成 HTTP 结果，开流后发 done。 */
export async function settleExecutedTurn(
  scope: TurnScope,
  result: GenerationResult,
  truncatedTurns: number
): Promise<ConversationTurnOutcome> {
  const { observations, turn, control, sink, emitStart, log, userId, session, mode, model } = scope;
  if (result.status === 'insufficient_balance' || result.denial === 'vip_required')
    await observations
      .markServer(turn.historyId, { billing_rejected: true })
      .catch(control.observationError);
  const current = await historyRecords().requireTurnById(turn.historyId);
  const persisted = await historyRecords().finalizeTurn({
    historyId: turn.historyId,
    content: result.content,
    status: isExternallyInterrupted(current.llm_finish_reason)
      ? 'stream_interrupted'
      : result.status,
    finishReason: isExternallyInterrupted(current.llm_finish_reason)
      ? current.llm_finish_reason
      : result.finishReason,
    upstreamStatus: result.upstreamStatus ?? null,
    chargeId: result.chargeId,
  });
  const status =
    persisted.status === 'success'
      ? 'complete'
      : persisted.status === 'stream_interrupted'
        ? 'interrupted'
        : 'failed';

  if (!sink.opened) {
    if (result.denial === 'vip_required') {
      return { kind: 'vip_required' };
    }
    if (result.status === 'insufficient_balance') {
      return {
        kind: 'insufficient_balance',
        creditsRequired: result.balance?.creditsRequired ?? 0,
        creditsAvailable: result.balance?.creditsAvailable ?? 0,
      };
    }
    if (result.status === 'upstream_error') {
      return { kind: 'upstream_error', upstreamStatus: result.upstreamStatus ?? null };
    }
    // 上游 2xx 但没有响应体：onStreamOpen 已经调过，理论到不了这里。
    // 真到了也得把流开出来，否则客户端拿到的是一个没有响应体的 200。
    emitStart();
  }

  sink.send({
    type: 'done',
    assistant_message_id: turn.historyId,
    status,
    finish_reason: persisted.llm_finish_reason,
  });
  sink.close();

  if (persisted.status === 'success') {
    // 回复终态、计费和 done 均已确认；该诊断只影响下一轮采用精简还是完整规则。
    // 不再让一次额外 snapshot 读取和 metadata 写入延长已关闭的 SSE handler。
    void persistRichReplyDiagnosis({
      historyId: turn.historyId,
      postprocessVersion: turn.postprocessVersion,
      slotModes: turn.slotModes,
      content: persisted.assistant_reply ?? result.content,
      log,
    });
  }

  log.biz.info(
    {
      event: 'conversation.turn.done',
      userId,
      sessionId: session.id,
      turnIndex: turn.turnIndex,
      revision: turn.revision,
      postprocessVersion: turn.postprocessVersion,
      mode: mode.kind,
      status,
      model: model.openRouterModelId,
      truncatedTurns,
      replyChars: result.content.length,
      clientGone: sink.clientGone,
    },
    '自研链路一轮生成收口'
  );

  return { kind: 'streamed', status };
}

/**
 * 开轮之后的任何失败都必须释放会话：首字超时先标记观测，再以 CAS 写终态；
 * 首字超时还要在抛出前补发 start，让浏览器报告真实等待时长。
 */
export async function failTurn(scope: TurnScope, err: unknown): Promise<never> {
  const { control, observations, turn, log, session, sink, emitStart } = scope;
  if (
    err instanceof FirstTokenDeadlineError ||
    control.signal.reason instanceof FirstTokenDeadlineError
  ) {
    control.abort(err instanceof FirstTokenDeadlineError ? err : control.signal.reason);
    if (control.observationBegun) {
      const stage = (control.signal.reason as FirstTokenDeadlineError).stage;
      await observations
        .markServer(turn.historyId, {
          first_token_timeout: stage === 'global',
          server_timeout_stage: stage,
        })
        .catch(control.observationError);
    }
  }
  // Prompt/history/precheck failures happen after startTurn and must release the
  // persisted session too. CAS leaves a concurrent cancellation/completion intact.
  if (err instanceof GenerationCleanupPendingError) {
    log.sys.error(
      {
        event: 'conversation.quota.cleanup_pending',
        err,
        sessionId: session.id,
        historyId: turn.historyId,
      },
      '额度收口未确认，保持会话占用等待恢复'
    );
    throw err;
  }
  const current = await historyRecords().requireTurnById(turn.historyId);
  await historyRecords().finalizeTurn({
    historyId: turn.historyId,
    content: '',
    status:
      control.signal.aborted || isExternallyInterrupted(current.llm_finish_reason)
        ? 'stream_interrupted'
        : 'upstream_error',
    finishReason: isExternallyInterrupted(current.llm_finish_reason)
      ? current.llm_finish_reason
      : control.signal.aborted
        ? 'timeout'
        : null,
  });
  if (control.signal.reason instanceof FirstTokenDeadlineError) {
    // Bind the failed revision before the error so the browser can report its actual wait.
    // This happens after safe failure/allowance cleanup, never before billing rejection.
    if (!sink.opened) emitStart();
    throw control.signal.reason;
  }
  throw err;
}

async function persistRichReplyDiagnosis(input: {
  historyId: string;
  postprocessVersion: number;
  slotModes: InstructionSlotModes;
  content: string;
  log: RequestLogger;
}): Promise<void> {
  try {
    const snapshots = await new TextPostprocessRepository().readSnapshots([
      input.postprocessVersion,
    ]);
    const artifact = snapshots.found[0]?.artifact;
    if (!artifact) throw new Error('bound text postprocess artifact is unavailable');
    const enabled = {
      choices: input.slotModes.choice !== 'off',
      status: input.slotModes.status !== 'off',
      memory: input.slotModes.memory !== 'off',
    };
    const diagnosis = diagnoseRichReplyProtocol(
      input.content,
      enabled,
      artifact.rich_reply_protocol?.enabled !== false,
      artifact.rich_reply_protocol?.recovery
    );
    await historyRecords().saveRichReplyMetadata(input.historyId, {
      rich_reply_mode:
        input.slotModes.choice === 'full' ||
        input.slotModes.status === 'full' ||
        input.slotModes.memory === 'full'
          ? 'full'
          : 'concise',
      ...diagnosis,
    });
  } catch (err) {
    // A completed reply must remain successful when this advisory snapshot cannot
    // be persisted. The next RPC treats missing metadata as full.
    input.log.sys.warn(
      { event: 'conversation.rich_reply.diagnosis_failed', err, historyId: input.historyId },
      '富文本协议诊断未写入；下一轮将保守使用完整规则'
    );
  }
}

/** A stale RPC may have no reason; explicitly close the billing pending-reason gate. */
export function normalizePersistedOutcome(
  observed: SseTapResult,
  status: string,
  finishReason: string | null
): SseTapResult {
  if (status === 'success') return observed;
  return { ...observed, completed: false, finishReason: finishReason ?? 'timeout' };
}
