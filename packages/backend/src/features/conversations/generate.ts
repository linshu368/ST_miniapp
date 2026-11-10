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
 *
 * 阶段实现：准备 turn-preparation.ts；计时与取消 turn-control.ts；
 * 请求、hooks、执行后收口与失败收口 turn-execution.ts。
 */

import {
  DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  type ChatMessageStatus,
} from '@miniapp/shared';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import type { CharacterCardRow } from '../../infrastructure/repositories/CharacterCardRepository.js';
import { observeChatFirstToken } from '../../lib/engineering-observability.js';
import type { RequestLogger } from '../../lib/logger.js';
import type { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';
import { buildPrompt, type EngineCharacter } from '../engine/index.js';
import type { InstructionSlotModes } from '../engine/types.js';
import { execute, type GenerationStatus, type ResolvedModel } from '../generation/index.js';
import {
  buildGenerationRequest,
  createExecutionHooks,
  failTurn,
  settleExecutedTurn,
} from './turn-execution.js';
import { buildEngineHistory } from './history.js';
import {
  createConversationPreparationTiming,
  type ConversationPreparationTiming,
} from './preparation-timing.js';
import type { ConversationStreamSink } from './sse.js';
import { prepareTurnInputs } from './turn-preparation.js';
import { createTurnScope } from './turn-scope.js';
import { characters, historyRecords, userSettings } from './turn-repositories.js';

export { withConversationPreparationDeadline } from './turn-preparation.js';
export { normalizePersistedOutcome } from './turn-execution.js';

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
  preparationTiming?: ConversationPreparationTiming;
  firstTokenDeadlineMs?: number;
  catalogSnapshot?: Awaited<ReturnType<typeof fetchModelCatalogSnapshot>>;
  /** Caller correlation, persisted for safe pre-start cancellation matching. */
  requestId?: string;
  thinkingEnabled?: boolean;
  firstTokenMeasurement?: 'client_committed_v4';
}

export const CONVERSATION_PREPARATION_TIMEOUT_MS = DEFAULT_FIRST_TOKEN_DEADLINE_MS;

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

type CatalogFirstTokenPolicy = NonNullable<ResolvedModel['firstTokenPolicy']>;
export type FirstTokenPolicy = CatalogFirstTokenPolicy & {
  fallbackModelId: string;
  fallbackTimeoutMs: number;
};

/** 目录给出的首字策略缺省时补默认值；路由传入的截止时间覆盖目录值。 */
export function resolveFirstTokenPolicy(
  catalogPolicy: CatalogFirstTokenPolicy | undefined,
  deadlineOverrideMs: number | undefined
): FirstTokenPolicy {
  return {
    fallbackModelId: FIRST_TOKEN_FALLBACK_MODEL_ID,
    timeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
    fallbackTimeoutMs: DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
    deadlineMs: DEFAULT_FIRST_TOKEN_DEADLINE_MS,
    timeoutRateTarget: DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
    catalogVersion: 0,
    ...catalogPolicy,
    ...(deadlineOverrideMs ? { deadlineMs: deadlineOverrideMs } : {}),
  };
}

export async function runConversationTurn(
  input: RunConversationTurnInput
): Promise<ConversationTurnOutcome> {
  const { session, mode, log } = input;
  // Old clients cannot display reasoning or cancel their legacy first-answer timer.
  const thinkingEnabled = input.thinkingEnabled ?? false;
  const userId = session.user_id;
  const turnStartedAt = input.receivedAt ?? Date.now();
  const requestStartedAt =
    input.receivedMonotonicAt ?? performance.now() - (Date.now() - turnStartedAt);
  const preparation =
    input.preparationTiming ?? createConversationPreparationTiming(requestStartedAt);
  preparation.enter('settings');
  const {
    chargeId,
    model,
    userConfig,
    displayName,
    instructions,
    windowLimits,
    executionPreparation,
    preparationSignal,
  } = await prepareTurnInputs({
    sessionId: session.id,
    characterId: session.character_id,
    userId,
    requestStartedAt,
    firstTokenDeadlineMs: input.firstTokenDeadlineMs,
    catalogSnapshot: input.catalogSnapshot,
    settings: userSettings(),
    history: historyRecords(),
    log,
  });

  // ── 落库：一轮一个 chat_history revision ─────────────────────────────────
  // 两个 RPC 都在会话行锁内做「生成中判定 + 陈旧流清理」，session_busy 与
  // regenerate_not_allowed 由它们以 SQLSTATE 抛出，仓库层已翻成业务错误码。
  preparationSignal.throwIfAborted();
  preparation.enter('turn_open', model);
  const turn = await startTurn(session.id, mode, model.openRouterModelId, windowLimits);
  preparation.enter('context');
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

  const policy = resolveFirstTokenPolicy(model.firstTokenPolicy, input.firstTokenDeadlineMs);
  model.firstTokenPolicy = policy;
  observeChatFirstToken({
    requestedModel: model.modelId,
    stage: 'accepted',
    deadlineMs: policy.deadlineMs,
    triggerMs: policy.timeoutMs,
  });
  const scope = createTurnScope({
    turnInput: input,
    userId,
    thinkingEnabled,
    requestStartedAt,
    diagnosticStartedAt: preparation.startedAt,
    turnStartedAt,
    turn,
    model,
    policy,
    chargeId,
  });
  const { observations, observationInput, control } = scope;

  try {
    // ── 组 prompt ─────────────────────────────────────────────────────────────
    const { prompt, truncatedTurns } = await loadTurnPrompt({
      registerObservation: async () => {
        await observations.begin({ ...observationInput, history: [] });
        control.markObservationBegun();
      },
      session,
      userId,
      turn,
      signal: control.signal,
      userConfig,
      displayName,
      instructions: instructions.instructions,
    });

    preparation.enter('dispatch_gate');
    const result = await execute(
      buildGenerationRequest(scope, prompt, executionPreparation),
      createExecutionHooks(scope, prompt, preparation),
      log
    );
    preparation.incomplete();
    return await settleExecutedTurn(scope, result, truncatedTurns);
  } catch (err) {
    preparation.incomplete();
    return await failTurn(scope, err);
  } finally {
    control.dispose();
  }
}

type PromptInput = Parameters<typeof buildPrompt>[0];

/**
 * 观测登记、上下文读取和角色卡读取并行，三者都落定后再组 prompt。
 * 登记必须先于失败收口完成：快速失败的上下文读取不能和迟到的身份写入竞争。
 */
async function loadTurnPrompt(input: {
  registerObservation: () => Promise<void>;
  session: ChatSessionRow;
  userId: string;
  turn: StartedTurn;
  signal: AbortSignal;
  userConfig: PromptInput['userConfig'];
  displayName: string;
  instructions: PromptInput['instructions'];
}) {
  const { session, turn } = input;
  // Context reads can overlap the one atomic admission write. Join both before
  // cleanup so a late admission cannot race a failed context's terminal state.
  const [registration, contextRead, cardRead] = await Promise.allSettled([
    input.registerObservation(),
    historyRecords().getContextBeforeTurn(session.id, turn.turnIndex, turn.contextWindowStartTurn),
    // startTurn has atomically bound the creator card version; never prefetch latest draft.
    characters().requireCard(session.character_id, input.userId, session.id),
  ]);
  // Finish registration before failure cleanup too. A fast context rejection
  // must not race a late identity write or omit the failed request's facts.
  if (registration.status === 'rejected') throw registration.reason;
  if (contextRead.status === 'rejected') throw contextRead.reason;
  if (cardRead.status === 'rejected') throw cardRead.reason;
  const card = cardRead.value;
  const context = contextRead.value;
  input.signal.throwIfAborted();
  const history = buildEngineHistory(context.messages, context.openingMessage ?? card.first_mes);

  const prompt = buildPrompt({
    character: toEngineCharacter(card),
    history,
    truncatedTurns: context.truncatedTurns,
    userInput: turn.userInput,
    userConfig: input.userConfig,
    slotModes: turn.slotModes,
    persona: { displayName: input.displayName },
    instructions: input.instructions,
  });
  return { prompt, truncatedTurns: context.truncatedTurns };
}

export interface StartedTurn {
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
