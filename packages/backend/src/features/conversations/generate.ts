/**
 * backend / features / conversations / generate.ts
 *
 * 一轮生成的编排（M3b）。方案 §8.2 的执行序列就落在这个文件里，发消息与重生成共用它。
 *
 * 这是 M1 / M2 / M3a 第一次在同一个进程里串起来，三处接缝都在这里合拢：
 *   - M1 getContextMessages（有序全量）→ 本文件切片 → M2 的 history + userInput
 *   - getGenerationConfig 同时喂 M2 的 userConfig 与 M3a 的模型解析
 *   - M3a 的 GenerationResult → M1 的 finalizeAssistantMessage（chat_history 由 execute 内部落）
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
import {
  ChatMessageRepository,
  type GenerationSnapshot,
} from '../../infrastructure/repositories/ChatMessageRepository.js';
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

let messageRepository: ChatMessageRepository | null = null;
let characterRepository: CharacterCardRepository | null = null;
let userSettingsRepository: MiniappUserSettingsRepository | null = null;

function messages(): ChatMessageRepository {
  return (messageRepository ??= new ChatMessageRepository());
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

  const snapshot: GenerationSnapshot = {
    modelId: model.modelId,
    modelOpenrouterId: model.openRouterModelId,
    // MVP 不消费预设（决策 7 二次修正）。自建格式定稿后由 M4 填这一列
    presetId: null,
    genConfig: userConfig,
  };

  // ── 落库：user 行 / 重生成版本 ────────────────────────────────────────────
  // 两个 RPC 都在会话行锁内做「生成中判定 + 陈旧流清理」，session_busy 与
  // regenerate_not_allowed 由它们以 SQLSTATE 抛出，仓库层已翻成业务错误码。
  const turn = await startTurn(session.id, mode, snapshot);

  // ── 组 prompt ─────────────────────────────────────────────────────────────
  const context = await messages().getContextMessages(session.id);
  const { history, tailMismatch } = buildEngineHistory(context, turn.userInput);
  if (tailMismatch) {
    log.sys.warn(
      { event: 'conversation.context.tail_mismatch', userId, sessionId: session.id },
      '上下文尾部与本轮输入不一致，可能存在并发写入'
    );
  }

  const prompt = buildPrompt({
    character: toEngineCharacter(card),
    history,
    userInput: turn.userInput,
    userConfig,
    persona: { displayName },
    instructions: instructions.instructions,
  });

  // 重生成的占位行由 RPC 在同事务内建好，这里只补发消息那条路径的。
  const assistant =
    turn.assistantMessageId === null
      ? await messages().startAssistantMessage({
          sessionId: session.id,
          turnIndex: turn.turnIndex,
          snapshot,
        })
      : { id: turn.assistantMessageId, revision: turn.revision };

  const emitStart = (): void => {
    sink.open();
    sink.send({
      type: 'start',
      turn_index: turn.turnIndex,
      user_message_id: turn.userMessageId,
      assistant_message_id: assistant.id,
      revision: assistant.revision,
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
  await messages().finalizeAssistantMessage({
    messageId: assistant.id,
    content: result.content,
    status,
    finishReason: result.finishReason,
    // status 已经表达了中断，error_code 留给「本轮没跑起来」的两种失败
    errorCode: status === 'failed' ? result.status : null,
    generationId: result.generationId,
    // execute 只在实际走到计费段时才给 chargeId，与 chat_history 的那条是同一个幂等键
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
    assistant_message_id: assistant.id,
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
      revision: assistant.revision,
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
  /** 重生成时为 null：该轮的 user 消息早已存在 */
  userMessageId: string | null;
  /** 重生成时由 RPC 在同事务内建好；发消息路径为 null，稍后单独插入 */
  assistantMessageId: string | null;
  revision: number;
  userInput: string;
}

async function startTurn(
  sessionId: string,
  mode: ConversationTurnMode,
  snapshot: GenerationSnapshot
): Promise<StartedTurn> {
  if (mode.kind === 'send') {
    const appended = await messages().appendUserTurn(sessionId, mode.content);
    return {
      turnIndex: appended.turnIndex,
      userMessageId: appended.userMessageId,
      assistantMessageId: null,
      revision: 0,
      userInput: mode.content,
    };
  }

  const started = await messages().startRegeneration({ sessionId, snapshot });
  return {
    turnIndex: started.turnIndex,
    userMessageId: null,
    assistantMessageId: started.assistantMessageId,
    revision: started.revision,
    userInput: started.userContent,
  };
}
