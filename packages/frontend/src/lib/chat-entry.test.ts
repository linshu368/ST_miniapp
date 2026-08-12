import { describe, expect, it } from 'vitest';

import { chatEntryPath } from './chat-entry';

describe('chatEntryPath', () => {
  it('自研链路进独立聊天页', () => {
    expect(chatEntryPath('self_hosted', 'char-1')).toBe('/chat/char-1');
  });

  it('自研链路带上要继续的会话 id', () => {
    expect(chatEntryPath('self_hosted', 'char-1', { sessionId: 'sess-1' })).toBe(
      '/chat/char-1?session=sess-1'
    );
  });

  it('ST 链路带上要继续的 chat 文件名', () => {
    expect(chatEntryPath('sillytavern', 'char-1', { legacyChatFile: '2026-01-01 @00h' })).toBe(
      '/tavern/char-1?chat=2026-01-01+%4000h'
    );
  });

  it('两条链路都不把对方的参数带出去', () => {
    expect(chatEntryPath('self_hosted', 'char-1', { legacyChatFile: 'x' })).toBe('/chat/char-1');
    expect(chatEntryPath('sillytavern', 'char-1', { sessionId: 'sess-1' })).toBe('/tavern/char-1');
  });
});
