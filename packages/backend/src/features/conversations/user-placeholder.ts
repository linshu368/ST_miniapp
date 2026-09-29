import {
  readPostprocessVersion,
  replaceUserPlaceholder,
  type ChatMessage,
  type ChatSession,
} from '@miniapp/shared';

export function applyUserPlaceholderToMessages(
  messages: ChatMessage[],
  displayName: string
): ChatMessage[] {
  return messages.map((message) => {
    // 带版本的 assistant 原文交给 renderer 替换占位符。这里替换会让展示规则看到昵称而不是原文。
    if (
      message.role === 'assistant' &&
      readPostprocessVersion(message.postprocess_version) !== null
    ) {
      return message;
    }
    if (!message.content.includes('{{user}}')) return message;
    return { ...message, content: replaceUserPlaceholder(message.content, displayName) };
  });
}

export function applyUserPlaceholderToSession(
  session: ChatSession,
  displayName: string
): ChatSession {
  if (!session.last_message_preview?.includes('{{user}}')) return session;
  return {
    ...session,
    last_message_preview: replaceUserPlaceholder(session.last_message_preview, displayName),
  };
}
