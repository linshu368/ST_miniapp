/**
 * 首页「最新」入口是否该显示 New 提醒。
 *
 * latestListedAt 取 app_core.characters.last_listed_at 的最大值。该字段只在角色卡
 * 由「未上架」转为「已上架」时刷新，因此运营做纯排序调整或改卡片内容都不会让 New
 * 误亮。userLastSeenAt 是用户最后一次进入「最新」分页的时间。
 *
 * 从未看过的用户（水位线为空）在有上架角色时视为有上新：对他来说整批都是新的。
 */
export function hasNewLobbyCharacters(
  latestListedAt: string | Date | null | undefined,
  userLastSeenAt: string | Date | null | undefined
): boolean {
  const listedAt = toTimestamp(latestListedAt);
  if (listedAt === null) return false;
  const seenAt = toTimestamp(userLastSeenAt);
  if (seenAt === null) return true;
  return listedAt > seenAt;
}

function toTimestamp(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}
