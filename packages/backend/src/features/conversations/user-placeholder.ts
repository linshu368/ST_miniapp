import { replaceUserPlaceholder, type ChatMessage, type ChatSession } from '@miniapp/shared';

export function applyUserPlaceholderToMessages(
  messages: ChatMessage[],
  displayName: string
): ChatMessage[] {
  return messages.map((message) => {
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
