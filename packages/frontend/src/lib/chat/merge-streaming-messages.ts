import {
  readPostprocessVersion,
  type ChatMessage,
  type ConversationStreamStartEvent,
} from '@miniapp/shared';

/** 流式期间叠在落库态之上的临时态。刻意不进 query cache，理由见 lib/api/conversations.ts */
export interface StreamingTurn {
  /** 重生成时要把落库的最后一条 assistant 消息藏起来，换成这条正在写的 */
  mode: 'send' | 'regenerate';
  /** 同一 turn/revision 的并发设备只能按本请求 UUID 归属。 */
  requestId?: string;
  /** 本地先构造的用户气泡，start 到达后换成真 id；重生成时为 null */
  userMessage: ChatMessage | null;
  assistantMessageId: string | null;
  turnIndex: number;
  revision: number;
  text: string;
  /**
   * 只来自本轮 start。缺失按 null。增量到达时不能改写，也不能改读当前配置。
   * start 之前还没有 assistant 气泡，这个 null 不会被展示成另一条规则。
   */
  postprocessVersion: number | null;
}

export function applyStreamStart(
  turn: StreamingTurn,
  event: ConversationStreamStartEvent
): StreamingTurn {
  return {
    ...turn,
    assistantMessageId: event.assistant_message_id,
    turnIndex: event.turn_index,
    revision: event.revision,
    postprocessVersion: readPostprocessVersion(event.postprocess_version),
    userMessage: turn.userMessage
      ? {
          ...turn.userMessage,
          id: event.user_message_id ?? turn.userMessage.id,
          turn_index: event.turn_index,
          revision: event.revision,
        }
      : null,
  };
}

/** 只追加原文。版本停留在 start 写下来的那一个。 */
export function appendStreamText(turn: StreamingTurn, text: string): StreamingTurn {
  return { ...turn, text: turn.text + text };
}

export function mergeStreamingMessages(
  persisted: ChatMessage[],
  streaming: StreamingTurn | null,
  sessionId: string | null
): ChatMessage[] {
  if (!streaming) return persisted;

  // 重生成写的是同一轮的新版本，落库的旧版本要让位，否则会并排出现两条 assistant
  const base =
    streaming.mode === 'regenerate' &&
    persisted.at(-1)?.role === 'assistant' &&
    (persisted.at(-1)!.revision < streaming.revision ||
      persisted.at(-1)!.id === streaming.assistantMessageId ||
      (streaming.requestId && persisted.at(-1)!.request_id === streaming.requestId))
      ? persisted.slice(0, -1)
      : persisted;

  const persistedAssistant = persisted.find(
    (message) =>
      message.role === 'assistant' &&
      (streaming.assistantMessageId
        ? message.id === streaming.assistantMessageId
        : Boolean(streaming.requestId) &&
          message.request_id === streaming.requestId &&
          message.turn_index === streaming.turnIndex &&
          message.revision === streaming.revision)
  );
  // 详情轮询可能先于 SSE done，已确认终态时优先展示服务端正文。
  if (persistedAssistant && persistedAssistant.status !== 'streaming') return persisted;
  const persistedUser = streaming.userMessage
    ? persisted.find(
        (message) =>
          message.role === 'user' &&
          (message.id === streaming.userMessage?.id ||
            (persistedAssistant && message.id === `${persistedAssistant.id}:user`))
      )
    : undefined;
  const assistantMessageId = streaming.assistantMessageId ?? persistedAssistant?.id;
  const merged = base.filter(
    (message) =>
      message.id !== assistantMessageId &&
      message.id !== streaming.userMessage?.id &&
      message.id !== persistedUser?.id
  );
  if (streaming.userMessage) merged.push(persistedUser ?? streaming.userMessage);
  if (assistantMessageId) {
    merged.push({
      id: assistantMessageId,
      session_id: sessionId ?? '',
      turn_index: streaming.turnIndex,
      role: 'assistant',
      revision: streaming.revision,
      request_id: streaming.requestId,
      content:
        persistedAssistant && persistedAssistant.content.length > streaming.text.length
          ? persistedAssistant.content
          : streaming.text,
      status: 'streaming',
      error_code: null,
      finish_reason: null,
      model_id: null,
      postprocess_version: streaming.postprocessVersion,
      created_at: new Date().toISOString(),
    });
  }
  return merged;
}
