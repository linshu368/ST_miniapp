import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';

import {
  applyMessageLike,
  resolveSessionTitle,
  SESSION_TITLE_DISPLAY_LENGTH,
} from './conversations';

describe('resolveSessionTitle', () => {
  it('uses the stored title when present', () => {
    expect(resolveSessionTitle('周末闲聊', '角色全名')).toBe('周末闲聊');
  });

  it(`truncates every title to ${SESSION_TITLE_DISPLAY_LENGTH} characters`, () => {
    expect(resolveSessionTitle('这是一个很长的会话标题')).toBe('这是一个很长的');
    expect(resolveSessionTitle(null, '这是一个很长的角色名字')).toBe('这是一个很长的');
  });

  it('falls back to the character name, then to 新的对话', () => {
    expect(resolveSessionTitle(null, '凤雪仪')).toBe('凤雪仪');
    expect(resolveSessionTitle('  ', '  ')).toBe('新的对话');
    expect(resolveSessionTitle(null)).toBe('新的对话');
  });

  it('counts unicode code points rather than UTF-16 code units', () => {
    expect(resolveSessionTitle('😀一二三四五六七')).toBe('😀一二三四五六');
  });
});

describe('回复点赞状态隔离', () => {
  function reply(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'history-20',
      session_id: 'source-session',
      turn_index: 20,
      role: 'assistant',
      revision: 0,
      content: '走到路口，等你决定方向。',
      status: 'complete',
      error_code: null,
      finish_reason: 'stop',
      model_id: 'test-model',
      created_at: '2026-10-29T00:00:00.000Z',
      ...overrides,
    };
  }

  it('确认只更新指定会话的指定版本，分支中同一来源消息不被连带点赞', () => {
    const source = reply();
    const inherited = reply({ session_id: 'branch-session', inherited: true });
    const newerRevision = reply({ id: 'history-20-new', revision: 1 });
    const updated = applyMessageLike([source, inherited, newerRevision], {
      session_id: 'source-session',
      message_id: 'history-20',
      liked: true,
    });
    expect(updated[0]?.liked).toBe(true);
    expect(updated[1]).toBe(inherited);
    expect(updated[2]).toBe(newerRevision);
    expect(source.liked).toBeUndefined();
  });

  it('取消喜欢将已确认值更新为 false，不修改消息内容', () => {
    const source = reply({ liked: true });
    expect(
      applyMessageLike([source], {
        session_id: source.session_id,
        message_id: source.id,
        liked: false,
      })
    ).toEqual([{ ...source, liked: false }]);
  });
});
