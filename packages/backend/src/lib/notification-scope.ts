import type { NotificationScope } from '@miniapp/shared';

export function parseNotificationScope(scope: string): NotificationScope | null {
  return scope === 'official' || scope === 'personal' ? scope : null;
}

/**
 * 官方消息是一条广播行，已读状态只落在 notification_reads 上，
 * 所以未读一律按「可见 id 减去已读 id」算，不能靠消息行自身的字段。
 */
export function selectUnreadIds(visibleIds: string[], readIds: Iterable<string>): string[] {
  const read = new Set(readIds);
  return visibleIds.filter((id) => !read.has(id));
}
