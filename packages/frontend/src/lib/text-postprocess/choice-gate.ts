import { TEXT_POSTPROCESS_LIMITS, type ChatMessage } from '@miniapp/shared';

import { getChatReplyPresentation } from '@/components/chat/chat-reply-presentation';

export interface ChoiceGates {
  generating: boolean;
  serverBusy: boolean;
  sessionReady: boolean;
}

export interface ChoiceHold {
  messageId: string;
  revision: number;
  phase: 'armed' | 'confirming';
  /** 点击时的会话缓存时间。刷新完成前不能把按钮打开。 */
  baselineUpdatedAt: number;
}

export interface ChoiceLockState {
  held: ChoiceHold | null;
  consumed: readonly string[];
}

export function emptyChoiceLock(): ChoiceLockState {
  return { held: null, consumed: [] };
}

export function choiceKey(message: Pick<ChatMessage, 'id' | 'revision'>): string {
  return `${message.id}:${message.revision}`;
}

function holdKey(hold: Pick<ChoiceHold, 'messageId' | 'revision'>): string {
  return `${hold.messageId}:${hold.revision}`;
}

export function normalizeChoiceText(
  text: string,
  maxLength: number = TEXT_POSTPROCESS_LIMITS.maxOptionUnits
): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

export function isLatestCompleteAssistant(
  message: ChatMessage,
  messages: readonly ChatMessage[]
): boolean {
  if (message.role !== 'assistant' || message.turn_index <= 0) return false;
  if (getChatReplyPresentation(message) !== 'complete') return false;
  const last = messages.at(-1);
  return Boolean(last && last.id === message.id && last.revision === message.revision);
}

export function choiceButtonsDisabled(input: {
  message: ChatMessage;
  messages: readonly ChatMessage[];
  gates: ChoiceGates;
  lock: ChoiceLockState;
}): boolean {
  const key = choiceKey(input.message);
  if (input.lock.consumed.includes(key)) return true;
  if (input.lock.held && holdKey(input.lock.held) === key) return true;
  if (input.gates.generating || input.gates.serverBusy || !input.gates.sessionReady) return true;
  return !isLatestCompleteAssistant(input.message, input.messages);
}

export function tryAdoptChoice(
  state: ChoiceLockState,
  input: {
    message: ChatMessage;
    messages: readonly ChatMessage[];
    text: string;
    gates: ChoiceGates;
    maxLength?: number;
    baselineUpdatedAt: number;
  }
): { state: ChoiceLockState; text: string | null } {
  const text = normalizeChoiceText(input.text, input.maxLength);
  if (!text) return { state, text: null };
  if (state.held) return { state, text: null };
  if (
    choiceButtonsDisabled({
      message: input.message,
      messages: input.messages,
      gates: input.gates,
      lock: state,
    })
  ) {
    return { state, text: null };
  }
  const key = choiceKey(input.message);
  return {
    text,
    state: {
      held: {
        messageId: input.message.id,
        revision: input.message.revision,
        phase: 'armed',
        baselineUpdatedAt: input.baselineUpdatedAt,
      },
      consumed: state.consumed.includes(key) ? state.consumed : [...state.consumed, key],
    },
  };
}

export function markChoiceAwaitingConfirmation(state: ChoiceLockState): ChoiceLockState {
  if (!state.held || state.held.phase === 'confirming') return state;
  return { ...state, held: { ...state.held, phase: 'confirming' } };
}

/**
 * 请求还在飞，或刷新还没带来更新的会话快照时，保持锁定。
 * 尾部已经出现后续消息就永久禁用；确认这一轮没有落下时才放开。
 */
export function settleChoiceLock(
  state: ChoiceLockState,
  input: {
    messages: readonly ChatMessage[];
    refreshing: boolean;
    querySettled: boolean;
    dataUpdatedAt: number;
  }
): ChoiceLockState {
  const held = state.held;
  if (!held || held.phase !== 'confirming') return state;
  if (input.refreshing || !input.querySettled) return state;
  if (input.dataUpdatedAt <= held.baselineUpdatedAt) return state;
  if (input.messages.some((message) => message.status === 'streaming')) return state;

  const key = holdKey(held);
  const index = input.messages.findIndex((message) => choiceKey(message) === key);
  const followed = index >= 0 && index < input.messages.length - 1;
  if (index < 0 || followed) {
    return { held: null, consumed: state.consumed };
  }
  return {
    held: null,
    consumed: state.consumed.filter((item) => item !== key),
  };
}
