/**
 * backend / features / conversations / generate.ts
 *
 * 一轮生成的编排（M3b）。方案 §8.2 的执行序列就落在这个文件里，发消息与重生成共用它。
 *
 * 这是 M1 / M2 / M3a 第一次在同一个进程里串起来，三处接缝都在这里合拢：
 *   - chat_history 当前 revision → 本文件还原开场白与历史 → M2 的 history + userInput
 *   - getGenerationConfig 同时喂 M2 的 userConfig 与 M3a 的模型解析
 *   - M3a 的 GenerationResult → 收口同一条 chat_history（execute 只补计费与 LLM 元数据）
 *
 * 顺序上有一条硬约束：**SSE 首字节写出之前不能有任何可能失败的判定**。402 与 409 要以
 * HTTP 状态码返回 JSON，响应头一旦发出就只能降级成流内 error 事件，前端处理成本高一截。
 * 所以响应头推迟到 M3a 的 onStreamOpen（上游已 2xx）才写。
 */

import type { ChatMessageStatus } from '@miniapp/shared';
import { buildPrompt, fetchPlatformInstructions, type EngineCharacter } from '../engine/index.js';
import {
  execute,
  resolveModelForUser,
  type GenerationRequest,
  type GenerationStatus,
} from '../generation/index.js';
import { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import {
  CharacterCardRepository,
  type CharacterCardRow,
} from '../../infrastructure/repositories/CharacterCardRepository.js';
import { MiniappUserSettingsRepository } from '../../infrastructure/repositories/MiniappUserSettingsRepository.js';
import type { RequestLogger } from '../../lib/logger.js';
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
  /** 上游连不上或非 2xx，响应头还没写，调用方返回 502 JSON */
  | { kind: 'upstream_error'; upstreamStatus: number | null };

export interface RunConversationTurnInput {
  session: ChatSessionRow;
  mode: ConversationTurnMode;
  sink: ConversationStreamSink;
  log: RequestLogger;
}

let historyRepository: ConversationHistoryRepository | null = null;
let characterRepository: CharacterCardRepository | null = null;
let userSettingsRepository: MiniappUserSettingsRepository | null = null;

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
  const userId = session.user_id;

  // ── 取数 ──────────────────────────────────────────────────────────────────
  // 五个读之间互不依赖，串行发会把一轮生成的启动时延叠成五个 RTT。
  // 都放在写入之前：这里抛异常时会话还没被动过，不会留下没有回复的孤儿 user 行。
  const [model, card, userConfig, displayName, instructions] = await Promise.all([
    resolveModelForUser(userId),
    characters().requireCard(session.character_id),
    userSettings().getGenerationConfig(userId),
    userSettings().getDisplayName(userId),
    fetchPlatformInstructions(),
  ]);

  if (instructions.degraded) {
    log.sys.error(
      { event: 'conversation.instructions.degraded', userId, sessionId: session.id },
      'runtime_config 平台规则已降级到内置兜底，输出质量会明显下降'
    );
  }

  // ── 落库：一轮一个 chat_history revision ─────────────────────────────────
  // 两个 RPC 都在会话行锁内做「生成中判定 + 陈旧流清理」，session_busy 与
  // regenerate_not_allowed 由它们以 SQLSTATE 抛出，仓库层已翻成业务错误码。
  const turn = await startTurn(session.id, mode, model.openRouterModelId);

  // ── 组 prompt ─────────────────────────────────────────────────────────────
  const context = await historyRecords().getContextBeforeTurn(session.id, turn.turnIndex);
  const history = buildEngineHistory(context.messages, context.openingMessage ?? card.first_mes);

  const prompt = buildPrompt({
    character: toEngineCharacter(card),
    history,
    userInput: turn.userInput,
    userConfig,
    persona: { displayName },
    instructions: instructions.instructions,
  });

  await historyRecords().setPromptHistory(turn.historyId, prompt.messages);

  const emitStart = (): void => {
    sink.open();
    sink.send({
      type: 'start',
      turn_index: turn.turnIndex,
      user_message_id: mode.kind === 'send' ? `${turn.historyId}:user` : null,
      assistant_message_id: turn.historyId,
      revision: turn.revision,
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
    presetId: null,
    stream: true,
    // 决策 11：cache_control 断点只在自研链路开，ST 链路传 false 保住 M3a 的纯重构判据
    promptCaching: true,
  };

  const result = await execute(
    request,
    {
      onStreamOpen: emitStart,
      onDelta: (text) => sink.send({ type: 'delta', text }),
    },
    log
  );

  const status = toMessageStatus(result.status);
  await historyRecords().finalizeTurn({
    historyId: turn.historyId,
    content: result.content,
    status: result.status,
    finishReason: result.finishReason,
    upstreamStatus: result.upstreamStatus ?? null,
    generationId: result.generationId,
    chargeId: result.chargeId,
  });

  if (!sink.opened) {
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
    finish_reason: result.finishReason,
  });
  sink.close();

  log.biz.info(
    {
      event: 'conversation.turn.done',
      userId,
      sessionId: session.id,
      turnIndex: turn.turnIndex,
      revision: turn.revision,
      mode: mode.kind,
      status,
      model: model.openRouterModelId,
      replyChars: result.content.length,
      clientGone: sink.clientGone,
    },
    '自研链路一轮生成收口'
  );

  return { kind: 'streamed', status };
}

interface StartedTurn {
  turnIndex: number;
  historyId: string;
  revision: number;
  userInput: string;
}

async function startTurn(
  sessionId: string,
  mode: ConversationTurnMode,
  model: string
): Promise<StartedTurn> {
  if (mode.kind === 'send') {
    const started = await historyRecords().startTurn({
      sessionId,
      userContent: mode.content,
      model,
    });
    return {
      turnIndex: started.turnIndex,
      historyId: started.historyId,
      revision: started.revision,
      userInput: started.userContent,
    };
  }

  const started = await historyRecords().startRegeneration({ sessionId, model });
  return {
    turnIndex: started.turnIndex,
    historyId: started.historyId,
    revision: started.revision,
    userInput: started.userContent,
  };
}
