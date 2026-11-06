/**
 * 一轮生成开轮之后各阶段共用的状态（TurnScope）及其创建：首发尝试 ID、SSE start 发送器、
 * 观测登记参数和 turn control。执行阶段见 turn-execution.ts。
 */
import { randomUUID } from 'node:crypto';
import type { GenerationObservationRepository } from '../../infrastructure/repositories/GenerationObservationRepository.js';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import type { RequestLogger } from '../../lib/logger.js';
import type { ResolvedModel } from '../generation/index.js';
import type {
  ConversationTurnMode,
  FirstTokenPolicy,
  RunConversationTurnInput,
  StartedTurn,
} from './generate.js';
import type { ConversationStreamSink } from './sse.js';
import { createTurnControl, type TurnControl } from './turn-control.js';
import { generationObservations, historyRecords } from './turn-repositories.js';

type ObservationInput = ReturnType<typeof buildObservationInput>;

export interface TurnScope {
  session: ChatSessionRow;
  mode: ConversationTurnMode;
  sink: ConversationStreamSink;
  log: RequestLogger;
  userId: string;
  thinkingEnabled: boolean;
  requestStartedAt: number;
  turn: StartedTurn;
  model: ResolvedModel;
  policy: FirstTokenPolicy;
  chargeId: string;
  observations: GenerationObservationRepository;
  observationInput: ObservationInput;
  control: TurnControl;
  emitStart: () => void;
  primaryAttemptId: string;
}

/** SSE start 只发一次。正常路径在派发门禁完成后发送。 */
function createStartEmitter(input: {
  sink: ConversationStreamSink;
  mode: ConversationTurnMode;
  turn: StartedTurn;
  model: ResolvedModel;
  policy: FirstTokenPolicy;
  diagnosticStartedAt: number;
  thinkingEnabled: boolean;
}): () => void {
  const { sink, mode, turn, model, policy, diagnosticStartedAt, thinkingEnabled } = input;
  let startEmitted = false;
  const emitStart = (): void => {
    if (startEmitted) return;
    startEmitted = true;
    sink.open();
    sink.send({
      type: 'start',
      first_token_deadline_ms: policy.deadlineMs,
      requested_model_id: model.modelId,
      fallback_trigger_ms: policy.timeoutMs,
      server_elapsed_ms: Math.round(performance.now() - diagnosticStartedAt),
      turn_index: turn.turnIndex,
      user_message_id: mode.kind === 'send' ? `${turn.historyId}:user` : null,
      assistant_message_id: turn.historyId,
      revision: turn.revision,
      thinking_enabled: thinkingEnabled,
      postprocess_version: turn.postprocessVersion,
    });
  };
  return emitStart;
}

function buildObservationInput(input: {
  turn: StartedTurn;
  chargeId: string;
  clientRequestId: string;
  primaryAttemptId: string;
  model: ResolvedModel;
  policy: FirstTokenPolicy;
  turnStartedAt: number;
  mode: ConversationTurnMode;
  firstTokenMeasurement: RunConversationTurnInput['firstTokenMeasurement'];
}) {
  const { turn, chargeId, clientRequestId, primaryAttemptId, model, policy, turnStartedAt, mode } =
    input;
  return {
    historyId: turn.historyId,
    chargeId,
    requestId: clientRequestId,
    primaryAttemptId,
    requestedModelId: model.modelId,
    provider: model.provider,
    model: model.providerModelId,
    receivedAt: new Date(turnStartedAt).toISOString(),
    timeoutMs: policy.timeoutMs,
    fallbackTimeoutMs: policy.fallbackTimeoutMs,
    deadlineMs: policy.deadlineMs,
    timeoutRateTarget: policy.timeoutRateTarget,
    fallbackModelId: policy.fallbackModelId,
    catalogVersion: policy.catalogVersion,
    mode: mode.kind,
    recoverableDelivery: true,
    // Declare the cohort with the existing insert so missing reports remain measurable.
    measurementMethod: input.firstTokenMeasurement,
  };
}

/**
 * 开轮之后各阶段共用的状态。创建顺序与原编排一致：先生成首发尝试 ID 与请求 ID，
 * 再建 start 发送器与观测参数，最后启动计时器和取消轮询（createTurnControl）。
 */
export function createTurnScope(input: {
  turnInput: RunConversationTurnInput;
  userId: string;
  thinkingEnabled: boolean;
  requestStartedAt: number;
  diagnosticStartedAt: number;
  turnStartedAt: number;
  turn: StartedTurn;
  model: ResolvedModel;
  policy: FirstTokenPolicy;
  chargeId: string;
}): TurnScope {
  const { turnInput, userId, thinkingEnabled, requestStartedAt, turn, model, policy } = input;
  const { session, mode, sink, log } = turnInput;
  const observations = generationObservations();
  const primaryAttemptId = randomUUID();
  const emitStart = createStartEmitter({
    sink,
    mode,
    turn,
    model,
    policy,
    diagnosticStartedAt: input.diagnosticStartedAt,
    thinkingEnabled,
  });
  const observationInput = buildObservationInput({
    turn,
    chargeId: input.chargeId,
    clientRequestId: turnInput.requestId ?? randomUUID(),
    primaryAttemptId,
    model,
    policy,
    turnStartedAt: input.turnStartedAt,
    mode,
    firstTokenMeasurement: turnInput.firstTokenMeasurement,
  });
  const control = createTurnControl({
    turn,
    sessionId: session.id,
    userId,
    requestedModelId: model.modelId,
    deadlineMs: policy.deadlineMs,
    requestStartedAt,
    turnStartedAt: input.turnStartedAt,
    history: historyRecords(),
    observations,
    log,
  });
  return {
    session,
    mode,
    sink,
    log,
    userId,
    thinkingEnabled,
    requestStartedAt,
    turn,
    model,
    policy,
    chargeId: input.chargeId,
    observations,
    observationInput,
    control,
    emitStart,
    primaryAttemptId,
  };
}
