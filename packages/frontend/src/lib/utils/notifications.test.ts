import { describe, expect, it } from 'vitest';
import type { SupportMessage } from '@miniapp/shared';
import { formatMessageTime, pendingOutbox } from './notifications';

const NOW = new Date(2026, 6, 28, 20, 0, 0);

function supportMessage(overrides: Partial<SupportMessage>): SupportMessage {
  return {
    id: 'server-1',
    sender: 'user',
    body: '充值没到账',
    client_msg_id: null,
    created_at: '2026-07-28T11:02:00.000Z',
    ...overrides,
  };
}

describe('formatMessageTime', () => {
  it('labels同一天的消息为今天，即使它比当前时间早很多', () => {
    expect(formatMessageTime(new Date(2026, 6, 28, 14, 20).toISOString(), NOW)).toBe('今天 14:20');
  });

  it('把昨天晚上的消息算作昨天而不是今天', () => {
    expect(formatMessageTime(new Date(2026, 6, 27, 20, 5).toISOString(), NOW)).toBe('昨天 20:05');
  });

  it('同年更早的消息带月日，跨年的只留日期', () => {
    expect(formatMessageTime(new Date(2026, 6, 25, 10, 0).toISOString(), NOW)).toBe('07-25 10:00');
    expect(formatMessageTime(new Date(2025, 11, 31, 23, 30).toISOString(), NOW)).toBe('2025-12-31');
  });
});

describe('pendingOutbox', () => {
  it('服务端确认后不再重复渲染本地气泡', () => {
    const pending = [{ clientMsgId: 'c1', body: '你好', status: 'sending' as const }];
    const confirmed = [supportMessage({ client_msg_id: 'c1' })];
    expect(pendingOutbox(pending, confirmed)).toEqual([]);
  });

  it('未确认的失败消息保留下来，用户可以点重试', () => {
    const pending = [
      { clientMsgId: 'c1', body: '你好', status: 'sending' as const },
      { clientMsgId: 'c2', body: '在吗', status: 'failed' as const },
    ];
    const confirmed = [supportMessage({ client_msg_id: 'c1' })];
    expect(pendingOutbox(pending, confirmed)).toEqual([
      { clientMsgId: 'c2', body: '在吗', status: 'failed' },
    ]);
  });

  it('客服侧没有 client_msg_id 的消息不会误伤本地待发', () => {
    const pending = [{ clientMsgId: 'c1', body: '你好', status: 'sending' as const }];
    const confirmed = [supportMessage({ sender: 'agent', client_msg_id: null })];
    expect(pendingOutbox(pending, confirmed)).toHaveLength(1);
  });
});
