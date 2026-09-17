import type { ChatMessage } from '@miniapp/shared';

/** 流式期间叠在落库态之上的临时态。刻意不进 query cache，理由见 lib/api/conversations.ts */
export interface StreamingTurn {
  /** 重生成时要把落库的最后一条 assistant 消息藏起来，换成这条正在写的 */
  mode: 'send' | 'regenerate';
  /** 本地先构造的用户气泡，start 到达后换成真 id；重生成时为 null */
  userMessage: ChatMessage | null;
  assistantMessageId: string | null;
  turnIndex: number;
  revision: number;
  text: string;
}

export function mergeStreamingMessages(
  persisted: ChatMessage[],
  streaming: StreamingTurn | null,
  sessionId: string | null
): ChatMessage[] {
  if (!streaming) return persisted;

  // 重生成写的是同一轮的新版本，落库的旧版本要让位，否则会并排出现两条 assistant
  const base =
    streaming.mode === 'regenerate' && persisted.at(-1)?.role === 'assistant'
      ? persisted.slice(0, -1)
      : persisted;

  const merged = [...base];
  if (streaming.userMessage) merged.push(streaming.userMessage);
  if (streaming.assistantMessageId) {
    merged.push({
      id: streaming.assistantMessageId,
      session_id: sessionId ?? '',
      turn_index: streaming.turnIndex,
      role: 'assistant',
      revision: streaming.revision,
      content: streaming.text,
      status: 'streaming',
      error_code: null,
      finish_reason: null,
      model_id: null,
      created_at: new Date().toISOString(),
    });
  }
  return merged;
}
