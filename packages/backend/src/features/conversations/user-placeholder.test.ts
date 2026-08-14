import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession } from '@miniapp/shared';

import {
  applyUserPlaceholderToMessages,
  applyUserPlaceholderToSession,
} from './user-placeholder.js';

const MESSAGE: ChatMessage = {
  id: 'm1',
  session_id: 's1',
  turn_index: 0,
  role: 'assistant',
  revision: 0,
  content: '你好，{{user}}。',
  status: 'complete',
  error_code: null,
  finish_reason: null,
  model_id: null,
  created_at: '2026-08-14T00:00:00.000Z',
};

const SESSION: ChatSession = {
  id: 's1',
  character_id: 'c1',
  title: null,
  last_message_at: null,
  last_message_preview: '你好，{{user}}。',
  message_count: 1,
  created_at: '2026-08-14T00:00:00.000Z',
  updated_at: '2026-08-14T00:00:00.000Z',
};

describe('applyUserPlaceholderToMessages', () => {
  it('replaces {{user}} in message content and leaves other messages untouched', () => {
    const plain: ChatMessage = { ...MESSAGE, id: 'm2', content: '嗯。' };
    expect(applyUserPlaceholderToMessages([MESSAGE, plain], '路人甲')).toEqual([
      { ...MESSAGE, content: '你好，路人甲。' },
      plain,
    ]);
  });
});

describe('applyUserPlaceholderToSession', () => {
  it('replaces {{user}} in last_message_preview', () => {
    expect(applyUserPlaceholderToSession(SESSION, '路人甲').last_message_preview).toBe(
      '你好，路人甲。'
    );
  });

  it('keeps a null preview', () => {
    const session = { ...SESSION, last_message_preview: null };
    expect(applyUserPlaceholderToSession(session, '路人甲')).toBe(session);
  });
});
