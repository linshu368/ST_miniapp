/**
 * backend / features / conversations / generate.ts
 *
 * 一轮生成的编排。发消息与重生成共用它，三处接缝都在这里合拢：
 *   - chat_history 当前 revision → 本文件还原开场白与历史 → engine 的 history + userInput
 *   - getGenerationConfig 同时喂 engine 的 userConfig 与 generation 的模型解析
 *   - generation 的 GenerationResult → finalizeTurn 收口同一条 chat_history
 *     （计费列与 LLM 元数据由 generation/settle.ts 异步补齐，与本文件写的列不重叠）
 *
 * 顺序上有一条硬约束：**SSE 首字节写出之前不能有任何可能失败的判定**。402 与 409 要以
 * HTTP 状态码返回 JSON，响应头一旦发出就只能降级成流内 error 事件，前端处理成本高一截。
 * 所以响应头推迟到 generation 的 onStreamOpen（上游已 2xx）才写。
 */

import { randomUUID } from 'node:crypto';
import {
  fetchGenerationDataForSettlement,
  buildGenerationMetadata,
} from '../generation/openrouter-metadata.js';
import { FirstTokenDeadlineError } from '../generation/first-token-fallback.js';
import { GenerationObservationRepository } from '../../infrastructure/repositories/GenerationObservationRepository.js';
import { GenerationCleanupPendingError } from '../generation/types.js';
import type { SseTapResult } from '../generation/upstream.js';
import {
  DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  diagnoseRichReplyProtocol,
  type ChatMessageStatus,
} from '@miniapp/shared';
import { buildPrompt, fetchPlatformInstructions, type EngineCharacter } from '../engine/index.js';
import type { InstructionSlotModes } from '../engine/types.js';
import {
  execute,
  resolveModelForUser,
  type GenerationRequest,
  type GenerationStatus,
} from '../generation/index.js';
import { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { TextPostprocessRepository } from '../text-postprocess/repository.js';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import {
  CharacterCardRepository,
  type CharacterCardRow,
} from '../../infrastructure/repositories/CharacterCardRepository.js';
import { MiniappUserSettingsRepository } from '../../infrastructure/repositories/MiniappUserSettingsRepository.js';
import type { RequestLogger } from '../../lib/logger.js';
import { fetchContextWindowLimits } from './context-window.js';
import { buildEngineHistory } from './history.js';
import type { ConversationStreamSink } from './sse.js';

/** 重生成不带入参：轮次由服务端取最后一轮（本轮决策 5） */
export type ConversationTurnMode = { kind: 'send'; content: string } | { kind: 'regenerate' };

/** 一轮生成的收口状态。streaming 是过程态，收口时不可能停在这里 */
export type SettledMessageStatus = Exclude<ChatMessageStatus, 'streaming'>;

export type ConversationTurnOutcome =
  /** 已经以 SSE 收场，调用方不要再碰 reply */
  | { kind: 'streamed'; status: SettledMessageStatus }
  /** 预检未通过，响应头还没写，调用方返回 402 JSON */
  | { kind: 'insufficient_balance'; creditsRequired: number; creditsAvailable: number }
  /** 调用方把已失效的标准/旗舰直接送进生成出口 */
  | { kind: 'vip_required' }
  /** 上游连不上或非 2xx，响应头还没写，调用方返回 502 JSON */
  | { kind: 'upstream_error'; upstreamStatus: number | null };

export interface RunConversationTurnInput {
  session: ChatSessionRow;
  mode: ConversationTurnMode;
  sink: ConversationStreamSink;
  log: RequestLogger;
  /** Route entry time: ownership/config preparation shares one budget. */
  receivedAt?: number;
  receivedMonotonicAt?: number;
  firstTokenDeadlineMs?: number;
  /** Caller correlation, persisted for safe pre-start cancellation matching. */
  requestId?: string;
  thinkingEnabled?: boolean;
}

let historyRepository: ConversationHistoryRepository | null = null;
let characterRepository: CharacterCardRepository | null = null;
let userSettingsRepository: MiniappUserSettingsRepository | null = null;
const generationObservations = () => new GenerationObservationRepository();

function historyRecords(): ConversationHistoryRepository {
  return (historyRepository ??= new ConversationHistoryRepository());
}
function characters(): CharacterCardRepository {
  return (characterRepository ??= new CharacterCardRepository());
}
function userSettings(): MiniappUserSettingsRepository {
  return (userSettingsRepository ??= new MiniappUserSettingsRepository());
}

export function toMessageStatus(status: GenerationStatus): SettledMessageStatus {
  switch (status) {
    case 'success':
      return 'complete';
    case 'stream_interrupted':
      return 'interrupted';
    case 'upstream_error':
    case 'insufficient_balance':
      return 'failed';
  }
}

export function toEngineCharacter(card: CharacterCardRow): EngineCharacter {
  return {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
  };
}

export async function runConversationTurn(
  input: RunConversationTurnInput
): Promise<ConversationTurnOutcome> {
  const { session, mode, sink, log } = input;
  // Old clients cannot display reasoning or cancel their legacy first-answer timer.
  const thinkingEnabled = input.thinkingEnabled ?? false;
  const userId = session.user_id;
  const turnStartedAt = input.receivedAt ?? Date.now();
  const requestStartedAt =
    input.receivedMonotonicAt ?? performance.now() - (Date.now() - turnStartedAt);
  const preparationRemainingMs =
    (input.firstTokenDeadlineMs ?? DEFAULT_FIRST_TOKEN_DEADLINE_MS) -
    (performance.now() - requestStartedAt);
  if (preparationRemainingMs <= 0) throw new FirstTokenDeadlineError();
  const preparationSignal = AbortSignal.timeout(Math.ceil(preparationRemainingMs));

  // ── 取数 ──────────────────────────────────────────────────────────────────
  // 六个读之间互不依赖，串行发会把一轮生成的启动时延叠成六个 RTT。
  // 都放在写入之前：这里抛异常时会话还没被动过，不会留下没有回复的孤儿 user 行。
  const [model, card, userConfig, displayName, instructions, windowLimits] =
    await withConversationPreparationDeadline(
      Promise.all([
        resolveModelForUser(userId),
        characters().requireCard(session.character_id),
        userSettings().getGenerationConfig(userId),
        userSettings().getDisplayName(userId),
        fetchPlatformInstructions(),
        fetchContextWindowLimits(),
      ]),
      preparationSignal
    );

  if (instructions.degraded) {
    log.sys.error(
      { event: 'conversation.instructions.degraded', userId, sessionId: session.id },
      'runtime_config 平台规则已降级到内置兜底，输出质量会明显下降'
    );
  }

  // ── 落库：一轮一个 chat_history revision ─────────────────────────────────
  // 两个 RPC 都在会话行锁内做「生成中判定 + 陈旧流清理」，session_busy 与
  // regenerate_not_allowed 由它们以 SQLSTATE 抛出，仓库层已翻成业务错误码。
  preparationSignal.throwIfAborted();
  await historyRecords().recoverStaleStreaming(session.id);
  preparationSignal.throwIfAborted();
  const turn = await startTurn(session.id, mode, model.openRouterModelId, windowLimits);
  log.biz.info(
    {
      event: 'conversation.instruction_slots.resolved',
      sessionId: session.id,
      turnIndex: turn.turnIndex,
      revision: turn.revision,
      slotModes: turn.slotModes,
    },
    '已使用持久化的平台规则槽位模式'
  );

  const policy = {
    fallbackModelId: FIRST_TOKEN_FALLBACK_MODEL_ID,
    timeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
    deadlineMs: DEFAULT_FIRST_TOKEN_DEADLINE_MS,
    timeoutRateTarget: DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
    catalogVersion: 0,
    ...model.firstTokenPolicy,
    ...(input.firstTokenDeadlineMs ? { deadlineMs: input.firstTokenDeadlineMs } : {}),
  };
  model.firstTokenPolicy = policy;
  const observations = generationObservations();
  const primaryAttemptId = randomUUID();
  const clientRequestId = input.requestId ?? randomUUID();
  const observationInput = {
    historyId: turn.historyId,
    requestId: clientRequestId,
    primaryAttemptId,
    requestedModelId: model.modelId,
    provider: model.provider,
    model: model.providerModelId,
    receivedAt: new Date(turnStartedAt).toISOString(),
    timeoutMs: policy.timeoutMs,
    deadlineMs: policy.deadlineMs,
    timeoutRateTarget: policy.timeoutRateTarget,
    fallbackModelId: policy.fallbackModelId,
    catalogVersion: policy.catalogVersion,
    mode: mode.kind,
  };
  const enrichedObserverIds = new Set<string>();
  let fallbackPrepared = false;
  let observationBegun = false;
  let emitted = false;
  const observationError = (err: unknown) =>
    log.sys.warn(
      { err, event: 'conversation.first_token.observation_failed', historyId: turn.historyId },
      '首 token 观测未写入'
    );
  const controller = new AbortController();
  const firstTokenTimer = setTimeout(
    () => controller.abort(new FirstTokenDeadlineError()),
    Math.max(1, policy.deadlineMs - (performance.now() - requestStartedAt))
  );
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, 110_000 - (Date.now() - turnStartedAt))
  );
  let stopped = false;
  let pollTimer: NodeJS.Timeout | undefined;
  const pollCancellation = async (): Promise<void> => {
    try {
      const row = await historyRecords().requireTurnById(turn.historyId);
      if (row.status !== 'streaming' || row.llm_finish_reason !== null) controller.abort();
    } catch (err) {
      log.sys.warn(
        {
          event: 'conversation.cancel.poll_failed',
          err,
          sessionId: session.id,
          historyId: turn.historyId,
        },
        '检查生成取消状态失败'
      );
    }
    if (!stopped && !controller.signal.aborted)
      pollTimer = setTimeout(() => void pollCancellation(), 1_000);
  };
  pollTimer = setTimeout(() => void pollCancellation(), 1_000);

  try {
    if (input.requestId)
      await historyRecords().setPendingRequestId(turn.historyId, input.requestId);
    await observations.begin(observationInput);
    observationBegun = true;
    controller.signal.throwIfAborted();
    // ── 组 prompt ─────────────────────────────────────────────────────────────
    const context = await historyRecords().getContextBeforeTurn(
      session.id,
      turn.turnIndex,
      turn.contextWindowStartTurn
    );
    const history = buildEngineHistory(context.messages, context.openingMessage ?? card.first_mes);

    const prompt = buildPrompt({
      character: toEngineCharacter(card),
      history,
      truncatedTurns: context.truncatedTurns,
      userInput: turn.userInput,
      userConfig,
      slotModes: turn.slotModes,
      persona: { displayName },
      instructions: instructions.instructions,
    });

    await historyRecords().setPromptHistory(turn.historyId, prompt.messages, input.requestId);

    const emitStart = (): void => {
      sink.open();
      sink.send({
        type: 'start',
        turn_index: turn.turnIndex,
        user_message_id: mode.kind === 'send' ? `${turn.historyId}:user` : null,
        assistant_message_id: turn.historyId,
        revision: turn.revision,
        thinking_enabled: thinkingEnabled,
        postprocess_version: turn.postprocessVersion,
      });
    };

    // ── 生成 ──────────────────────────────────────────────────────────────────
    const request: GenerationRequest = {
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
        store: {
          prepareFallback: async (attempt, triggeredMs) => {
            fallbackPrepared = true;
            await observations.prepareFallback(turn.historyId, attempt, triggeredMs);
          },
          observe: async (attempt) => {
            await observations.observe(turn.historyId, attempt);
            // The discarded primary stops at its first token; read only bounded provider metadata.
            if (
              fallbackPrepared &&
              attempt.role === 'primary' &&
              attempt.provider === 'openrouter' &&
              attempt.generation_id &&
              attempt.end_reason &&
              !enrichedObserverIds.has(attempt.generation_id)
            ) {
              enrichedObserverIds.add(attempt.generation_id);
              void fetchGenerationDataForSettlement(attempt.generation_id)
                .then(async (data) => {
                  if (data)
                    await observations.enrichGeneration(
                      attempt.generation_id!,
                      buildGenerationMetadata(data)
                    );
                })
                .catch(observationError);
            }
          },
          selectDelivery: (attempt) => observations.selectDelivery(turn.historyId, attempt),
        },
      },
      thinkingEnabled,
      signal: controller.signal,
      // Anthropic prompt cache 的 cache_control 断点，配合双水位线泄洪制造稳定前缀
      promptCaching: true,
    };

    const emitVisibleDelta = (type: 'delta' | 'reasoning', text: string): void => {
      if (!emitted && performance.now() - requestStartedAt >= policy.deadlineMs)
        controller.abort(new FirstTokenDeadlineError());
      controller.signal.throwIfAborted();
      sink.send({ type, text });
      if (!emitted && text.trim()) {
        emitted = true;
        clearTimeout(firstTokenTimer);
        void observations
          .markServer(turn.historyId, {
            first_token_emitted_ms: performance.now() - requestStartedAt,
          })
          .catch(observationError);
      }
    };

    const result = await execute(
      request,
      {
        onBeforeDispatch: async (snapshot) => {
          controller.signal.throwIfAborted();
          await observations.begin({ ...observationInput, snapshot });
          controller.signal.throwIfAborted();
        },
        onBeforeReserve: async (chargeId) => {
          controller.signal.throwIfAborted();
          await historyRecords().registerChargeId(turn.historyId, chargeId);
          controller.signal.throwIfAborted();
        },
        onBeforeSettle: async (observed, releaseReservation) => {
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
          if (thinkingEnabled) emitVisibleDelta('reasoning', text);
        },
      },
      log
    );

    if (result.status === 'insufficient_balance' || result.denial === 'vip_required')
      await observations
        .markServer(turn.historyId, { billing_rejected: true })
        .catch(observationError);
    const current = await historyRecords().requireTurnById(turn.historyId);
    const persisted = await historyRecords().finalizeTurn({
      historyId: turn.historyId,
      content: result.content,
      status: current.llm_finish_reason === 'cancelled' ? 'stream_interrupted' : result.status,
      finishReason: current.llm_finish_reason === 'cancelled' ? 'cancelled' : result.finishReason,
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
      await persistRichReplyDiagnosis({
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
        truncatedTurns: context.truncatedTurns,
        replyChars: result.content.length,
        clientGone: sink.clientGone,
      },
      '自研链路一轮生成收口'
    );

    return { kind: 'streamed', status };
  } catch (err) {
    if (
      observationBegun &&
      (err instanceof FirstTokenDeadlineError ||
        controller.signal.reason instanceof FirstTokenDeadlineError)
    )
      await observations
        .markServer(turn.historyId, { first_token_timeout: true })
        .catch(observationError);
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
        controller.signal.aborted || current.llm_finish_reason === 'cancelled'
          ? 'stream_interrupted'
          : 'upstream_error',
      finishReason:
        current.llm_finish_reason === 'cancelled'
          ? 'cancelled'
          : controller.signal.aborted
            ? 'timeout'
            : null,
    });
    if (controller.signal.reason instanceof FirstTokenDeadlineError)
      throw new FirstTokenDeadlineError();
    throw err;
  } finally {
    clearTimeout(firstTokenTimer);
    stopped = true;
    clearTimeout(timeout);
    if (pollTimer) clearTimeout(pollTimer);
  }
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

interface StartedTurn {
  turnIndex: number;
  historyId: string;
  revision: number;
  userInput: string;
  /** 开轮 RPC 在同一事务里算出的窗口起点，组上下文时直接用，不再回读会话 */
  contextWindowStartTurn: number;
  postprocessVersion: number;
  slotModes: InstructionSlotModes;
}

async function startTurn(
  sessionId: string,
  mode: ConversationTurnMode,
  model: string,
  windowLimits: { maxTurns: number; retainTurns: number }
): Promise<StartedTurn> {
  if (mode.kind === 'send') {
    const started = await historyRecords().startTurn({
      sessionId,
      userContent: mode.content,
      model,
      // Explicit recovery owns quota cleanup; the legacy RPC guard must not unlock
      // a row that crosses the 120-second horizon between recovery and this RPC.
      staleAfterSeconds: 24 * 60 * 60,
      maxContextTurns: windowLimits.maxTurns,
      retainContextTurns: windowLimits.retainTurns,
    });
    return {
      turnIndex: started.turnIndex,
      historyId: started.historyId,
      revision: started.revision,
      userInput: started.userContent,
      contextWindowStartTurn: started.contextWindowStartTurn,
      postprocessVersion: started.postprocessVersion,
      slotModes: started.slotModes,
    };
  }

  const started = await historyRecords().startRegeneration({
    sessionId,
    model,
    staleAfterSeconds: 24 * 60 * 60,
    maxContextTurns: windowLimits.maxTurns,
    retainContextTurns: windowLimits.retainTurns,
  });
  return {
    turnIndex: started.turnIndex,
    historyId: started.historyId,
    revision: started.revision,
    userInput: started.userContent,
    contextWindowStartTurn: started.contextWindowStartTurn,
    postprocessVersion: started.postprocessVersion,
    slotModes: started.slotModes,
  };
}

/** Bound read-only preparation even if a dependency fails to honor its own timeout. */
export function withConversationPreparationDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
