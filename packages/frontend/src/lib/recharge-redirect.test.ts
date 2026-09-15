import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './api/client';
import { ConversationStreamError } from './api/conversation-stream';
import { setReplaySessionStorageForTests } from './payment/session-storage';
import {
  isInsufficientCreditsError,
  rechargePath,
  redirectToRecharge,
  redirectToRechargeFromError,
  requiredCreditsFromError,
} from './recharge-redirect';

const characterId = '22222222-2222-4222-8222-222222222222';
const conversationSessionId = '33333333-3333-4333-8333-333333333333';
const replayContextId = '11111111-1111-4111-8111-111111111111';

const enterPaywallFollowup = vi.fn(async () => {});
const capture = vi.fn();
const getSnapshot = vi.fn(() => ({
  state: 'chat' as const,
  replayContextId,
  telemetryReady: true,
  streaming: false,
}));

vi.mock('@/lib/telemetry', () => ({
  getReplayLifecycle: () => ({
    enterPaywallFollowup,
    capture,
    getSnapshot,
  }),
}));

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

beforeEach(() => {
  enterPaywallFollowup.mockClear();
  capture.mockClear();
  getSnapshot.mockClear();
  setReplaySessionStorageForTests(memoryStorage());
});

afterEach(() => {
  setReplaySessionStorageForTests(undefined);
});

describe('isInsufficientCreditsError', () => {
  it('同时认对话/语音的 snake 码和切模型的 SCREAMING 码', () => {
    expect(
      isInsufficientCreditsError(new ApiClientError('余额不足', 402, 'insufficient_balance'))
    ).toBe(true);
    expect(
      isInsufficientCreditsError(new ApiClientError('余额不足', 402, 'INSUFFICIENT_CREDITS'))
    ).toBe(true);
    expect(
      isInsufficientCreditsError(
        new ConversationStreamError('余额不足', 402, 'insufficient_balance')
      )
    ).toBe(true);
  });

  it('其它错误码或没有 code 的不算', () => {
    expect(isInsufficientCreditsError(new ApiClientError('冲突', 409, 'CONFLICT'))).toBe(false);
    expect(isInsufficientCreditsError(new ApiClientError('API error: 402', 402))).toBe(false);
    expect(isInsufficientCreditsError(new Error('网络异常'))).toBe(false);
    expect(isInsufficientCreditsError(null)).toBe(false);
  });
});

describe('requiredCreditsFromError', () => {
  it('从 balance.creditsRequired 取出金额', () => {
    expect(
      requiredCreditsFromError(
        new ConversationStreamError('余额不足', 402, 'insufficient_balance', {
          creditsRequired: 50,
          creditsAvailable: 10,
        })
      )
    ).toBe(50);
    expect(
      requiredCreditsFromError(
        new ApiClientError('余额不足', 402, 'insufficient_balance', {
          creditsRequired: 12,
          creditsAvailable: 0,
        })
      )
    ).toBe(12);
  });

  it('没有金额时不编造', () => {
    expect(
      requiredCreditsFromError(new ApiClientError('余额不足', 402, 'INSUFFICIENT_CREDITS'))
    ).toBe(undefined);
  });
});

describe('rechargePath / redirectToRecharge', () => {
  it('始终带 reason 和 returnTo，有金额才写 required，不把 continuation 写入 URL', () => {
    expect(rechargePath({ returnTo: '/chat/c1?session=s1' })).toBe(
      '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1%3Fsession%3Ds1'
    );
    expect(
      rechargePath({ returnTo: '/chat/c1', requiredCredits: 50, triggerSource: 'chat_sse' })
    ).toBe('/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1&required=50');
    expect(rechargePath({ returnTo: '/chat/c1', triggerSource: 'chat_sse' })).not.toContain(
      'trigger'
    );
  });

  it('redirectToRechargeFromError 命中才 push', async () => {
    const router = { push: vi.fn() };
    expect(
      redirectToRechargeFromError(router, new ApiClientError('冲突', 409, 'CONFLICT'), '/chat/c1')
    ).toBe(false);
    expect(router.push).not.toHaveBeenCalled();

    expect(
      redirectToRechargeFromError(
        router,
        new ApiClientError('余额不足', 402, 'insufficient_balance', {
          creditsRequired: 8,
          creditsAvailable: 0,
        }),
        '/chat/c1'
      )
    ).toBe(true);
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(
        '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1&required=8'
      );
    });
  });

  it('redirectToRecharge 先进入 paywall followup 再 push', async () => {
    const router = { push: vi.fn() };
    const order: string[] = [];
    enterPaywallFollowup.mockImplementation(async () => {
      order.push('followup');
    });
    router.push.mockImplementation(() => {
      order.push('push');
    });

    await redirectToRecharge(router, { returnTo: '/chat/c1' });
    expect(order).toEqual(['followup', 'push']);
    expect(router.push).toHaveBeenCalledWith(
      '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1'
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it('有 triggerSource 和会话身份时才发 paywall_triggered，事件不含 pay_url', async () => {
    const router = { push: vi.fn() };
    await redirectToRecharge(router, {
      returnTo: `/chat/${characterId}?session=${conversationSessionId}`,
      requiredCredits: 12,
      triggerSource: 'chat_sse',
    });
    expect(enterPaywallFollowup).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      event: 'paywall_triggered',
      trigger_source: 'chat_sse',
      character_id: characterId,
      conversation_session_id: conversationSessionId,
      selected_model_id: null,
      required_credits: 12,
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('pay_url');
    expect(router.push.mock.calls[0]?.[0]).not.toContain('pay_url');
    expect(router.push.mock.calls[0]?.[0]).not.toContain('chat_sse');
  });
});
