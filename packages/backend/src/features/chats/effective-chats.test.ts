import { describe, expect, it } from 'vitest';
import type { UserChatListItem } from '@miniapp/shared';
import {
  isEffectiveChat,
  latestChatForCharacter,
  latestChatPerCharacter,
  sortChatsByActivity,
} from './effective-chats.js';

const base: UserChatListItem = {
  fileName: 'chat-1',
  characterAvatar: 'platform_character.png',
  characterAvatarUrl: 'https://example.com/character.png',
  characterName: '角色',
  characterId: 'character-1',
  isGroup: false,
  lastMessage: '你好',
  lastMessageAt: '2026-07-20T10:00:00.000Z',
  messageCount: 3,
  fileSize: 100,
};

describe('effective chats', () => {
  it('filters greeting-only, empty, group, and unmapped conversations', () => {
    expect(isEffectiveChat(base)).toBe(true);
    expect(isEffectiveChat({ ...base, messageCount: 2 })).toBe(false);
    expect(isEffectiveChat({ ...base, fileName: '' })).toBe(false);
    expect(isEffectiveChat({ ...base, isGroup: true })).toBe(false);
    expect(isEffectiveChat({ ...base, characterId: null })).toBe(false);
  });

  it('sorts by last message time descending', () => {
    const newer = { ...base, fileName: 'newer', lastMessageAt: '2026-07-21T10:00:00.000Z' };
    expect(sortChatsByActivity([base, newer]).map((item) => item.fileName)).toEqual([
      'newer',
      'chat-1',
    ]);
  });

  it('keeps only the latest conversation for each character', () => {
    const newest = {
      ...base,
      fileName: 'newest',
      lastMessageAt: '2026-07-22T10:00:00.000Z',
    };
    const other = {
      ...base,
      fileName: 'other',
      characterId: 'character-2',
      lastMessageAt: '2026-07-21T10:00:00.000Z',
    };
    expect(latestChatPerCharacter([base, other, newest]).map((item) => item.fileName)).toEqual([
      'newest',
      'other',
    ]);
  });

  it('returns the latest effective conversation for a character', () => {
    const newest = {
      ...base,
      fileName: 'newest',
      lastMessageAt: '2026-07-22T10:00:00.000Z',
    };
    const greetingOnly = {
      ...base,
      fileName: 'greeting-only',
      lastMessageAt: '2026-07-23T10:00:00.000Z',
      messageCount: 2,
    };
    expect(latestChatForCharacter([base, newest, greetingOnly], 'character-1')?.fileName).toBe(
      'newest'
    );
    expect(latestChatForCharacter([base], 'missing')).toBeNull();
  });
});
