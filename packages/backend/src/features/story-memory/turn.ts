/**
 * 生成链路上的记忆接入：读取最新记忆（与准备阶段并行）、按正文字数决定窗口。
 *
 * 硬约束：记忆对聊天回复的额外等待不超过 100ms。
 *   - 读取在准备阶段就发出，与模型解析、开轮、上下文读取并行；
 *   - 用到它时最多再等 STORY_MEMORY_MAX_EXTRA_WAIT_MS，没回来就当本轮没有记忆；
 *   - 窗口前移/请求压缩的写入不等待——本轮 prompt 直接用决策结果，写失败下一轮会重新算。
 */
import type { StoryMemoryConfig } from '@miniapp/shared';
import { StoryMemoryRepository } from '../../infrastructure/repositories/StoryMemoryRepository.js';
import type { RequestLogger } from '../../lib/logger.js';
import { countChars, type StoryTurn, turnBodyChars } from './text.js';
import { decideContextWindow, planContextWindow, type WindowAction } from './window-plan.js';

/** 用到记忆时最多额外等待的时间（总预算 100ms，留出窗口计算等其他余量） */
export const STORY_MEMORY_MAX_EXTRA_WAIT_MS = 50;
/** 读取本身的上限，只用于释放连接；对用户的等待由上面的额外等待上限约束 */
const STORY_MEMORY_READ_ABORT_MS = 1_000;

export type StoryMemoryReadOutcome = 'hit' | 'empty' | 'late' | 'timeout' | 'error';

export interface StoryMemoryRead {
  content: string | null;
  /** 最新记忆覆盖到的轮次；没有记忆为 0，读取失败/超时/迟到为 null（未知） */
  coveredEndTurn: number | null;
  outcome: StoryMemoryReadOutcome;
  readMs: number;
}

let repository: StoryMemoryRepository | null = null;
export function storyMemories(): StoryMemoryRepository {
  return (repository ??= new StoryMemoryRepository());
}

/** 永不 reject。 */
export function readStoryMemoryForTurn(sessionId: string): Promise<StoryMemoryRead> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const signal = AbortSignal.timeout(STORY_MEMORY_READ_ABORT_MS);
  return storyMemories()
    .readLatest(sessionId, signal)
    .then(
      (latest): StoryMemoryRead => ({
        content: latest?.content ?? null,
        coveredEndTurn: latest?.coveredEndTurn ?? 0,
        outcome: latest ? 'hit' : 'empty',
        readMs: elapsed(),
      }),
      (): StoryMemoryRead => ({
        content: null,
        coveredEndTurn: null,
        outcome: signal.aborted ? 'timeout' : 'error',
        readMs: elapsed(),
      })
    );
}

/** 生成链路取记忆结果：已落定就直接用，否则最多再等一小段，超时按"本轮无记忆"处理。 */
export function awaitStoryMemory(read: Promise<StoryMemoryRead>): Promise<StoryMemoryRead> {
  const waitStartedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<StoryMemoryRead>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          content: null,
          coveredEndTurn: null,
          outcome: 'late',
          readMs: Math.round(performance.now() - waitStartedAt),
        }),
      STORY_MEMORY_MAX_EXTRA_WAIT_MS
    );
    timer.unref();
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

export interface WindowedTurns {
  turns: StoryTurn[];
  startTurn: number;
  action: WindowAction;
}

export function applyStoryMemoryWindow(input: {
  sessionId: string;
  turns: StoryTurn[];
  currentStart: number;
  userInput: string;
  config: StoryMemoryConfig;
  memory: StoryMemoryRead;
  log: RequestLogger;
}): WindowedTurns {
  const { sessionId, config, log, currentStart } = input;
  const plan = planContextWindow({
    turns: input.turns.map((turn) => ({ turnIndex: turn.turnIndex, chars: turnBodyChars(turn) })),
    currentInputChars: countChars(input.userInput),
    currentStart,
    limits: config,
  });
  const decision = decideContextWindow({
    plan,
    currentStart,
    coverage: input.memory.coveredEndTurn,
    memoryEnabled: config.enabled,
    limits: config,
  });

  if (decision.action !== 'keep' || plan.floorBinding) {
    log.biz.info(
      {
        event: 'story_memory.window.planned',
        sessionId,
        action: decision.action,
        fromStart: currentStart,
        toStart: decision.startTurn,
        targetEnd: decision.targetEnd,
        coveredEndTurn: input.memory.coveredEndTurn,
        floorBinding: plan.floorBinding,
        totalChars: plan.totalChars,
        removedTurns: plan.removedTurns,
        removedChars: plan.removedChars,
      },
      '上下文窗口决策'
    );
  }

  if (decision.targetEnd !== null) {
    void storyMemories()
      .advanceWindow(sessionId, currentStart, decision.startTurn, decision.targetEnd)
      .then((applied) => {
        if (!applied) {
          log.sys.warn(
            { event: 'story_memory.window.advance_skipped', sessionId },
            '窗口起点已被移动，本次写入跳过'
          );
        }
      })
      .catch((err: unknown) =>
        log.sys.error(
          { err, event: 'story_memory.window.advance_failed', sessionId },
          '窗口前移/压缩请求写入失败，下一轮会重新计算'
        )
      );
  }

  return {
    turns: input.turns.filter((turn) => turn.turnIndex >= decision.startTurn),
    startTurn: decision.startTurn,
    action: decision.action,
  };
}
