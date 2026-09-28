export function applyReadToNotifications<T extends { id: string; is_read: boolean }>(
  items: T[],
  ids: ReadonlySet<string>
): { items: T[]; newlyReadIds: string[] } {
  if (ids.size === 0) return { items, newlyReadIds: [] };
  const newlyReadIds: string[] = [];
  const next = items.map((item) => {
    if (!ids.has(item.id) || item.is_read) return item;
    newlyReadIds.push(item.id);
    return { ...item, is_read: true };
  });
  return { items: next, newlyReadIds };
}

export function subtractUnread(
  current: { official: number; personal: number; total: number },
  counts: { official: number; personal: number }
): { official: number; personal: number; total: number } {
  const official = Math.max(0, current.official - counts.official);
  const personal = Math.max(0, current.personal - counts.personal);
  return { official, personal, total: official + personal };
}
