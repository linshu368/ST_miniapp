import type { ChatMessage } from '@miniapp/shared';

export type ChatReplyPresentation = 'complete' | 'incomplete' | 'empty';

/**
 * 只按用户实际看到的结果分类。finish_reason 仅用于兼容改造前已经落库的历史消息，
 * 不会作为面向用户的错误原因展示。
 */
export function getChatReplyPresentation(message: ChatMessage): ChatReplyPresentation | null {
  if (message.role !== 'assistant' || message.status === 'streaming') return null;

  const hasVisibleContent = message.content.trim().length > 0;
  if (!hasVisibleContent) return 'empty';

  const legacyIncomplete =
    message.status === 'complete' &&
    message.finish_reason !== null &&
    message.finish_reason !== 'stop';

  if (message.status === 'complete' && !legacyIncomplete) return 'complete';
  return 'incomplete';
}

/** 只用稳定消息作为分支锚点，开场白和未完成的回复不提供入口。 */
export function canBranchFromMessage(message: ChatMessage): boolean {
  return message.turn_index > 0 && getChatReplyPresentation(message) === 'complete';
}

/** 反馈针对已完成的角色回复，包括当前分支内的继承回复。 */
export function canLikeMessage(message: ChatMessage): boolean {
  return message.turn_index > 0 && getChatReplyPresentation(message) === 'complete';
}
