import { describe, expect, it } from 'vitest';
import { hasUnreadAgentReply } from './support-unread.js';

describe('hasUnreadAgentReply', () => {
  it('没有客服回复时不显示红点', () => {
    expect(hasUnreadAgentReply(null, null)).toBe(false);
    expect(hasUnreadAgentReply(undefined, '2026-08-01T00:00:00Z')).toBe(false);
  });

  it('从未打开过聊天页时，任何客服回复都算未读', () => {
    expect(hasUnreadAgentReply('2026-08-01T00:00:00Z', null)).toBe(true);
  });

  it('回复晚于阅读时间才算未读', () => {
    expect(hasUnreadAgentReply('2026-08-01T00:00:01Z', '2026-08-01T00:00:00Z')).toBe(true);
    expect(hasUnreadAgentReply('2026-08-01T00:00:00Z', '2026-08-01T00:00:01Z')).toBe(false);
  });

  it('回复与阅读同一时刻按已读处理，避免进页后红点立刻回来', () => {
    expect(hasUnreadAgentReply('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(false);
  });

  it('时间戳无法解析时不误报红点，除非本来就没读过', () => {
    expect(hasUnreadAgentReply('not-a-date', '2026-08-01T00:00:00Z')).toBe(false);
    expect(hasUnreadAgentReply('2026-08-01T00:00:00Z', 'not-a-date')).toBe(true);
  });
});
