import { describe, expect, it } from 'vitest';
import {
  isNotificationVisibleToUser,
  parseNotificationScope,
  selectUnreadIds,
} from './notification-scope.js';

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

describe('notification visibility', () => {
  const me = '11111111-1111-4111-8111-111111111111';
  const someoneElse = '22222222-2222-4222-8222-222222222222';

  it('shows broadcast announcements to everyone', () => {
    expect(isNotificationVisibleToUser({ scope: 'official', user_id: null }, me)).toBe(true);
  });

  it('shows an operations grant notice only to its recipient', () => {
    expect(isNotificationVisibleToUser({ scope: 'official', user_id: me }, me)).toBe(true);
    expect(isNotificationVisibleToUser({ scope: 'official', user_id: someoneElse }, me)).toBe(
      false
    );
  });

  it('keeps personal messages private', () => {
    expect(isNotificationVisibleToUser({ scope: 'personal', user_id: me }, me)).toBe(true);
    expect(isNotificationVisibleToUser({ scope: 'personal', user_id: someoneElse }, me)).toBe(
      false
    );
  });
});
