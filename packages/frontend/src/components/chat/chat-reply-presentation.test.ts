import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';

import {
  canBranchFromMessage,
  canLikeMessage,
  getChatReplyPresentation,
} from './chat-reply-presentation';

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    session_id: 'session-1',
    turn_index: 1,
    role: 'assistant',
    revision: 0,
    content: '完整回复',
    status: 'complete',
    error_code: null,
    finish_reason: 'stop',
    model_id: 'model-1',
    created_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('getChatReplyPresentation', () => {
  it('自然结束且有正文时为 complete', () => {
    expect(getChatReplyPresentation(assistant())).toBe('complete');
  });

  it('有正文但异常结束时为 incomplete', () => {
    expect(getChatReplyPresentation(assistant({ status: 'interrupted' }))).toBe('incomplete');
  });

  it('兼容旧的非 stop 完成记录，将其视为 incomplete', () => {
    expect(
      getChatReplyPresentation(assistant({ status: 'complete', finish_reason: 'content_filter' }))
    ).toBe('incomplete');
  });

  it('终态没有可见正文时为 empty', () => {
    expect(getChatReplyPresentation(assistant({ status: 'interrupted', content: '  ' }))).toBe(
      'empty'
    );
    expect(getChatReplyPresentation(assistant({ status: 'failed', content: '' }))).toBe('empty');
  });

  it('生成中不提前判定终态', () => {
    expect(getChatReplyPresentation(assistant({ status: 'streaming' }))).toBeNull();
  });
});

describe('可用的回复操作（分支与点赞）', () => {
  it('历史完整回复与继承回复都可操作，不局限于最新一轮', () => {
    expect(canBranchFromMessage(assistant({ turn_index: 20 }))).toBe(true);
    expect(canBranchFromMessage(assistant({ inherited: true }))).toBe(true);
    expect(canLikeMessage(assistant({ turn_index: 20 }))).toBe(true);
    expect(canLikeMessage(assistant({ inherited: true }))).toBe(true);
  });

  it.each<Partial<ChatMessage>>([
    { turn_index: 0 },
    { role: 'user' },
    { content: '   ' },
    { status: 'streaming' },
    { status: 'failed' },
    { status: 'interrupted' },
    { finish_reason: 'length' },
  ])('不为未完成、空白或非回复内容提供入口: %j', (overrides) => {
    expect(canBranchFromMessage(assistant(overrides))).toBe(false);
    expect(canLikeMessage(assistant(overrides))).toBe(false);
  });
});
