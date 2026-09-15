import { describe, expect, it, vi } from 'vitest';

import { isChatReplayPath, shouldEndChatReplayAfterLeave } from './use-chat-session';

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe('isChatReplayPath', () => {
  it('treats chat and custom-voice routes as the same replay context', () => {
    expect(isChatReplayPath('/chat/abc')).toBe(true);
    expect(isChatReplayPath('/chat/abc/voice/msg-1')).toBe(true);
    expect(isChatReplayPath('/chat/abc?session=s1')).toBe(true);
  });

  it('does not treat lobby, history list or paywall routes as chat replay', () => {
    expect(isChatReplayPath('/')).toBe(false);
    expect(isChatReplayPath('/chats')).toBe(false);
    expect(isChatReplayPath('/profile')).toBe(false);
    expect(isChatReplayPath('/profile/recharge')).toBe(false);
    expect(isChatReplayPath('/chat/abc/voice')).toBe(false);
    expect(isChatReplayPath('/chat/abc/settings')).toBe(false);
  });
});

describe('shouldEndChatReplayAfterLeave', () => {
  it('ends only when no chat/voice page remains and lifecycle is still chat', () => {
    expect(shouldEndChatReplayAfterLeave({ occupancy: 0, pathname: '/', state: 'chat' })).toBe(
      true
    );
    expect(shouldEndChatReplayAfterLeave({ occupancy: 0, pathname: '/chats', state: 'chat' })).toBe(
      true
    );
  });

  it('does not end while occupying chat/voice or during paywall continuation', () => {
    expect(
      shouldEndChatReplayAfterLeave({
        occupancy: 1,
        pathname: '/',
        state: 'chat',
      })
    ).toBe(false);
    expect(
      shouldEndChatReplayAfterLeave({
        occupancy: 0,
        pathname: '/chat/abc/voice/m1',
        state: 'chat',
      })
    ).toBe(false);
    expect(
      shouldEndChatReplayAfterLeave({
        occupancy: 0,
        pathname: '/profile/recharge',
        state: 'paywall_followup',
      })
    ).toBe(false);
    expect(
      shouldEndChatReplayAfterLeave({
        occupancy: 0,
        pathname: '/profile/orders',
        state: 'external_payment_pending',
      })
    ).toBe(false);
    expect(
      shouldEndChatReplayAfterLeave({
        occupancy: 0,
        pathname: '/profile/recharge',
        state: 'chat',
        paywallContinuationActive: true,
      })
    ).toBe(false);
    expect(shouldEndChatReplayAfterLeave({ occupancy: 0, pathname: '/', state: 'idle' })).toBe(
      false
    );
  });
});
