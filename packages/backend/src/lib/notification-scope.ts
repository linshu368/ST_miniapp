import type { NotificationScope } from '@miniapp/shared';

export function parseNotificationScope(scope: string): NotificationScope | null {
  return scope === 'official' || scope === 'personal' ? scope : null;
}

/**
 * 官方消息的已读状态只落在 notification_reads 上，
 * 所以未读一律按「可见 id 减去已读 id」算，不能靠消息行自身的字段。
 */
export function selectUnreadIds(visibleIds: string[], readIds: Iterable<string>): string[] {
  const read = new Set(readIds);
  return visibleIds.filter((id) => !read.has(id));
}

/**
 * 官方消息既可能是广播（user_id 为空），也可能是运营定向发放（user_id 为本人），
 * 定向给别人的那条对当前用户不可见，也不能被他标记已读。
 */
export function isNotificationVisibleToUser(
  row: { scope: NotificationScope; user_id: string | null },
  userId: string
): boolean {
  if (row.scope === 'official') return row.user_id === null || row.user_id === userId;
  return row.user_id === userId;
}
