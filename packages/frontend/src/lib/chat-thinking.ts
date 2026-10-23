import { MAX_CONVERSATION_REASONING_LENGTH, type ChatMessage } from '@miniapp/shared';

export const MAX_LOCAL_THINKING_MESSAGES = 12;
export type MessageThinkingMap = Readonly<Record<string, string>>;

export function messageThinkingKey(message: Pick<ChatMessage, 'session_id' | 'id' | 'revision'>) {
  return `${message.session_id}:${message.id}:${message.revision}`;
}

/** Only the current page keeps thinking text. It never enters persisted message content. */
export function appendMessageThinking(
  messages: MessageThinkingMap,
  key: string,
  delta: string
): MessageThinkingMap {
  const previous = messages[key] ?? '';
  const next = (previous + delta).slice(0, MAX_CONVERSATION_REASONING_LENGTH);
  if (next === previous) return messages;
  const entries = Object.entries(messages).filter(([existing]) => existing !== key);
  return Object.fromEntries([...entries.slice(-(MAX_LOCAL_THINKING_MESSAGES - 1)), [key, next]]);
}

export type ThinkingDisclosurePhase = 'thinking' | 'settled';
export function thinkingDisclosurePhase(
  streaming: boolean,
  content: string
): ThinkingDisclosurePhase {
  return streaming && !content.trim() ? 'thinking' : 'settled';
}

export function thinkingDisclosureOpen(
  phase: ThinkingDisclosurePhase,
  manual: { phase: ThinkingDisclosurePhase; open: boolean } | null
): boolean {
  return manual?.phase === phase ? manual.open : phase === 'thinking';
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Per-user device preference; only a boolean is stored, never any thinking text. */
export function readThinkingPreference(
  userScope: string,
  storage: PreferenceStorage | null = browserStorage()
): boolean {
  try {
    return storage?.getItem(`st.chat.thinking.v1:${userScope}`) !== 'off';
  } catch {
    return true;
  }
}

export function writeThinkingPreference(
  userScope: string,
  enabled: boolean,
  storage: PreferenceStorage | null = browserStorage()
): void {
  try {
    storage?.setItem(`st.chat.thinking.v1:${userScope}`, enabled ? 'on' : 'off');
  } catch {
    // The current page still works when WebView storage is unavailable.
  }
}
