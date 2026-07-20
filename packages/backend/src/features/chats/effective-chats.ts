import type { UserChatListItem } from '@miniapp/shared';

export const MIN_COMPLETED_ROUND_MESSAGE_COUNT = 3;

export function isEffectiveChat(item: UserChatListItem): boolean {
  return (
    !item.isGroup &&
    item.characterId !== null &&
    item.fileName.length > 0 &&
    item.messageCount >= MIN_COMPLETED_ROUND_MESSAGE_COUNT
  );
}

export function sortChatsByActivity(items: UserChatListItem[]): UserChatListItem[] {
  return [...items].sort((left, right) => {
    return timestampValue(right.lastMessageAt) - timestampValue(left.lastMessageAt);
  });
}

export function latestChatForCharacter(
  items: UserChatListItem[],
  characterId: string
): UserChatListItem | null {
  return (
    sortChatsByActivity(items.filter(isEffectiveChat)).find(
      (item) => item.characterId === characterId
    ) ?? null
  );
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
