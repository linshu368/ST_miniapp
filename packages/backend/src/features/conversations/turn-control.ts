import { observeChatFirstToken } from '../../lib/engineering-observability.js';
import type { RequestLogger } from '../../lib/logger.js';
import type { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import type { GenerationObservationRepository } from '../../infrastructure/repositories/GenerationObservationRepository.js';
import { FirstTokenDeadlineError } from '../generation/first-token-fallback.js';
import { beginActiveDelivery, endActiveDelivery } from './active-delivery.js';

/**
 * 一轮生成的中止与首字状态。
 *
 * 首字截止计时器、110 秒总超时、每秒取消轮询、首字超时记录和观测登记状态原本散落在
 * runConversationTurn 的闭包里；收进一个对象后，delta 发送、execute hooks 和失败收口
 * 共用同一份状态，避免拆分时把可变量拷贝成值。创建即启动计时器与轮询，dispose 统一清理。
 */
export interface TurnControl {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  /** 首字已就绪的耗时（相对路由入口）；还没出字时为 null。 */
  readonly readyMs: number | null;
  /** 第一次出字：记下就绪耗时并停掉首字截止计时器。 */
  markReady(): number;
  stopFirstTokenTimer(): void;
  recordFirstTokenTimeout(): void;
  /** 观测行已写入；若截止已先到，补记超时。 */
  markObservationBegun(): void;
  readonly observationBegun: boolean;
  /** 首字检查点写入；结算前必须等它完成。 */
  checkpoint: Promise<void> | undefined;
  observationError(err: unknown): void;
  dispose(): void;
}

export function createTurnControl(input: {
  turn: { historyId: string; revision: number };
  sessionId: string;
  userId: string;
  requestedModelId: string;
  deadlineMs: number;
  requestStartedAt: number;
  turnStartedAt: number;
  history: ConversationHistoryRepository;
  observations: GenerationObservationRepository;
  log: RequestLogger;
}): TurnControl {
  const { turn, sessionId, log, observations } = input;
  let observationBegun = false;
  let readyMs: number | null = null;
  let firstTokenDeadlineElapsed = false;
  let firstTokenTimeoutRecorded = false;
  const observationError = (err: unknown) =>
    log.sys.warn(
      { err, event: 'conversation.first_token.observation_failed', historyId: turn.historyId },
      '首 token 观测未写入'
    );
  const recordFirstTokenTimeout = (): void => {
    // Engineering telemetry must not depend on the receipt write being available.
    if (!firstTokenDeadlineElapsed)
      observeChatFirstToken({
        requestedModel: input.requestedModelId,
        stage: 'timeout',
        deadlineMs: input.deadlineMs,
      });
    firstTokenDeadlineElapsed = true;
    if (!observationBegun || firstTokenTimeoutRecorded) return;
    firstTokenTimeoutRecorded = true;
    void observations
      .markServer(turn.historyId, { first_token_timeout: true, server_timeout_stage: 'global' })
      .catch(observationError);
  };
  const controller = new AbortController();
  const firstTokenTimer = setTimeout(
    () => {
      recordFirstTokenTimeout();
      controller.abort(new FirstTokenDeadlineError());
    },
    Math.max(1, input.deadlineMs - (performance.now() - input.requestStartedAt))
  );
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, 110_000 - (Date.now() - input.turnStartedAt))
  );
  let stopped = false;
  let pollTimer: NodeJS.Timeout | undefined;
  const pollCancellation = async (): Promise<void> => {
    try {
      const row = await input.history.requireTurnState(turn.historyId);
      if (row.llm_finish_reason === 'user_cancelled') clearTimeout(firstTokenTimer);
      if (row.status !== 'streaming' || row.llm_finish_reason !== null) controller.abort();
    } catch (err) {
      log.sys.warn(
        {
          event: 'conversation.cancel.poll_failed',
          err,
          sessionId,
          historyId: turn.historyId,
        },
        '检查生成取消状态失败'
      );
    }
    if (!stopped && !controller.signal.aborted)
      pollTimer = setTimeout(() => void pollCancellation(), 1_000);
  };
  pollTimer = setTimeout(() => void pollCancellation(), 1_000);
  beginActiveDelivery(turn.historyId, input.userId, sessionId, turn.revision);

  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    get readyMs() {
      return readyMs;
    },
    markReady: () => {
      readyMs ??= performance.now() - input.requestStartedAt;
      clearTimeout(firstTokenTimer);
      return readyMs;
    },
    stopFirstTokenTimer: () => clearTimeout(firstTokenTimer),
    recordFirstTokenTimeout,
    markObservationBegun: () => {
      observationBegun = true;
      if (firstTokenDeadlineElapsed) recordFirstTokenTimeout();
    },
    get observationBegun() {
      return observationBegun;
    },
    checkpoint: undefined,
    observationError,
    dispose: () => {
      endActiveDelivery(turn.historyId);
      clearTimeout(firstTokenTimer);
      stopped = true;
      clearTimeout(timeout);
      if (pollTimer) clearTimeout(pollTimer);
    },
  };
}
