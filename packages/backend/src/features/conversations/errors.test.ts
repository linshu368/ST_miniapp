import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { ConversationErrorCode } from '@miniapp/shared';
import { ConversationRepositoryError } from '../../infrastructure/repositories/conversation-errors.js';
import { conversationErrorStatus, sendConversationError } from './errors.js';

function fakeReply(): {
  reply: FastifyReply;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  return { reply: { status } as unknown as FastifyReply, status, send };
}

describe('conversationErrorStatus', () => {
  const expected: Record<ConversationErrorCode, number> = {
    session_not_found: 404,
    character_not_found: 404,
    session_busy: 409,
    insufficient_balance: 402,
    regenerate_not_allowed: 409,
    upstream_error: 502,
  };

  for (const [code, status] of Object.entries(expected)) {
    it(`${code} → ${status}`, () => {
      expect(conversationErrorStatus(code as ConversationErrorCode)).toBe(status);
    });
  }
});

describe('sendConversationError', () => {
  it('业务错误按映射的状态码返回，错误码原样进 envelope', () => {
    const { reply, status, send } = fakeReply();

    const handled = sendConversationError(
      reply,
      new ConversationRepositoryError(
        'session_busy',
        'chat session ... already has a streaming reply'
      )
    );

    expect(handled).toBe(true);
    expect(status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'session_busy', message: expect.any(String) },
    });
  });

  it('未知异常不处理，交给调用方按 500 走', () => {
    const { reply, status } = fakeReply();

    expect(sendConversationError(reply, new Error('连接数据库失败'))).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });
});
