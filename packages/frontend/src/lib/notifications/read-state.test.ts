import { describe, expect, it } from 'vitest';

import { applyReadToNotifications, subtractUnread } from './read-state';

describe('notification read cache', () => {
  const items = [
    { id: 'a', is_read: false },
    { id: 'b', is_read: false },
    { id: 'c', is_read: true },
  ];

  it('marks only the clicked id', () => {
    const applied = applyReadToNotifications(items, new Set(['b']));
    expect(applied.newlyReadIds).toEqual(['b']);
    expect(applied.items.map((item) => item.is_read)).toEqual([false, true, true]);
  });

  it('does not treat an empty id set as reading the whole page', () => {
    const applied = applyReadToNotifications(items, new Set());
    expect(applied.newlyReadIds).toEqual([]);
    expect(applied.items).toBe(items);
  });

  it('decrements unread by the ids that were actually unread', () => {
    expect(
      subtractUnread({ official: 2, personal: 1, total: 3 }, { official: 1, personal: 0 })
    ).toEqual({ official: 1, personal: 1, total: 2 });
    expect(
      subtractUnread({ official: 0, personal: 0, total: 0 }, { official: 1, personal: 1 })
    ).toEqual({ official: 0, personal: 0, total: 0 });
  });
});
