import { describe, expect, it } from 'vitest';
import { parseNotificationScope, selectUnreadIds } from './notification-scope.js';

describe('notification scope', () => {
  it('only accepts the two message center tabs', () => {
    expect(parseNotificationScope('official')).toBe('official');
    expect(parseNotificationScope('personal')).toBe('personal');
    expect(parseNotificationScope('system')).toBeNull();
    expect(parseNotificationScope('')).toBeNull();
  });
});

describe('unread selection', () => {
  it('treats a notification without a read row as unread', () => {
    expect(selectUnreadIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('reports nothing once every visible notification has been read', () => {
    expect(selectUnreadIds(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('ignores read rows for notifications the user cannot see', () => {
    expect(selectUnreadIds(['a'], ['a', 'z'])).toEqual([]);
    expect(selectUnreadIds([], ['z'])).toEqual([]);
  });
});
