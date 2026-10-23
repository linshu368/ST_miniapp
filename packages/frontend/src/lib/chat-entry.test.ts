import { describe, expect, it } from 'vitest';

import { chatEntryPath } from './chat-entry';
import { resolveRoleplaySource, roleplayReturnPath } from './roleplay-navigation';

describe('chatEntryPath', () => {
  it('进独立聊天页', () => {
    expect(chatEntryPath('char-1')).toBe('/chat/char-1');
  });

  it('带上要继续的会话 id', () => {
    expect(chatEntryPath('char-1', { sessionId: 'sess-1' })).toBe('/chat/char-1?session=sess-1');
  });
});

describe('roleplay entry origins', () => {
  it('carries the conversation origin without changing the session identity', () => {
    const href = chatEntryPath('role/a', { sessionId: 'story ?&', source: 'conversations' });
    const url = new URL(href, 'https://example.test');
    expect(url.pathname).toBe('/chat/role%2Fa');
    expect(url.searchParams.get('session')).toBe('story ?&');
    expect(roleplayReturnPath(url.searchParams.get('from'))).toBe('/chats');
  });
  it('keeps explicit new stories separate from an existing story', () => {
    expect(chatEntryPath('role', { source: 'discover' })).toBe('/chat/role?from=discover');
  });
  it('returns old and untrusted links to discovery', () => {
    for (const source of [undefined, null, '', 'https://other.test', '/profile', 'CONVERSATIONS']) {
      expect(roleplayReturnPath(source)).toBe('/');
      expect(resolveRoleplaySource(source)).toBe('discover');
    }
  });
});
