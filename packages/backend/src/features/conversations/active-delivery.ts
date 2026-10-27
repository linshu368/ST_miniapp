import { MAX_CONVERSATION_REASONING_LENGTH, type ChatMessage } from '@miniapp/shared';

// Only a bounded accelerator for an already-authorized conversation read. The first
// checkpoint and final reply remain durable; another process can recover from those.
const active = new Map<
  string,
  {
    userId: string;
    sessionId: string;
    revision: number;
    expiresAt: number;
    content: string;
    reasoning: string;
  }
>();
const MAX_ACTIVE = 128;
const MAX_CONTENT = 262_144;
function sweep(): void {
  for (const [id, value] of active) if (value.expiresAt <= Date.now()) active.delete(id);
}
export function beginActiveDelivery(
  id: string,
  userId: string,
  sessionId: string,
  revision: number
): void {
  sweep();
  if (active.size >= MAX_ACTIVE) active.delete(active.keys().next().value!);
  active.set(id, {
    userId,
    sessionId,
    revision,
    expiresAt: Date.now() + 125_000,
    content: '',
    reasoning: '',
  });
}
export function appendActiveDelivery(id: string, kind: 'delta' | 'reasoning', text: string): void {
  const value = active.get(id);
  if (!value) return;
  if (kind === 'delta') value.content = (value.content + text).slice(0, MAX_CONTENT);
  else value.reasoning = (value.reasoning + text).slice(0, MAX_CONVERSATION_REASONING_LENGTH);
}
export function endActiveDelivery(id: string): void {
  active.delete(id);
}
export function recoverActiveDelivery(
  messages: ChatMessage[],
  userId: string,
  sessionId: string
): ChatMessage[] {
  sweep();
  return messages.map((message) => {
    const value = active.get(message.id);
    if (
      !value ||
      message.role !== 'assistant' ||
      message.status !== 'streaming' ||
      value.userId !== userId ||
      value.sessionId !== sessionId ||
      value.revision !== message.revision
    )
      return message;
    return {
      ...message,
      content: value.content.length > message.content.length ? value.content : message.content,
      ...(value.reasoning ? { reasoning: value.reasoning } : {}),
    };
  });
}
