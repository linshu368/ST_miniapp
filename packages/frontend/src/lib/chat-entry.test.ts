import { describe, expect, it } from 'vitest';

import { chatEntryPath } from './chat-entry';

describe('chatEntryPath', () => {
  it('进独立聊天页', () => {
    expect(chatEntryPath('char-1')).toBe('/chat/char-1');
  });

  it('带上要继续的会话 id', () => {
    expect(chatEntryPath('char-1', { sessionId: 'sess-1' })).toBe('/chat/char-1?session=sess-1');
  });
});
