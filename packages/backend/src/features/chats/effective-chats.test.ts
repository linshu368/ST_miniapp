import { describe, expect, it } from 'vitest';
import type { UserChatListItem } from '@miniapp/shared';
import { isEffectiveChat, latestChatForCharacter, sortChatsByActivity } from './effective-chats.js';

const base: UserChatListItem = {
  fileName: 'chat-1',
  characterAvatar: 'platform_character.png',
  characterName: '角色',
  characterId: 'character-1',
  isGroup: false,
  lastMessage: '你好',
  lastMessageAt: '2026-07-20T10:00:00.000Z',
  messageCount: 3,
  fileSize: 100,
};

describe('effective chats', () => {
  it('hides greeting-only, empty, group, and unmapped conversations', () => {
    expect(isEffectiveChat(base)).toBe(true);
    expect(isEffectiveChat({ ...base, messageCount: 2 })).toBe(false);
    expect(isEffectiveChat({ ...base, fileName: '' })).toBe(false);
    expect(isEffectiveChat({ ...base, isGroup: true })).toBe(false);
    expect(isEffectiveChat({ ...base, characterId: null })).toBe(false);
  });

  it('sorts by the real last message timestamp', () => {
    const newer = { ...base, fileName: 'newer', lastMessageAt: '2026-07-21T10:00:00.000Z' };
    expect(sortChatsByActivity([base, newer]).map((item) => item.fileName)).toEqual([
      'newer',
      'chat-1',
    ]);
  });

  it('selects the latest effective conversation for a character', () => {
    const newest = {
      ...base,
      fileName: 'newest',
      lastMessageAt: '2026-07-22T10:00:00.000Z',
    };
    const hidden = {
      ...base,
      fileName: 'hidden',
      lastMessageAt: '2026-07-23T10:00:00.000Z',
      messageCount: 1,
    };
    expect(latestChatForCharacter([base, newest, hidden], 'character-1')?.fileName).toBe('newest');
  });
});
