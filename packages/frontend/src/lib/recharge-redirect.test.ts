import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from './api/client';
import { ConversationStreamError } from './api/conversation-stream';
import {
  isInsufficientCreditsError,
  rechargePath,
  redirectToRecharge,
  redirectToRechargeFromError,
  requiredCreditsFromError,
} from './recharge-redirect';

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
  it('始终带 reason 和 returnTo，有金额才写 required', () => {
    expect(rechargePath({ returnTo: '/chat/c1?session=s1' })).toBe(
      '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1%3Fsession%3Ds1'
    );
    expect(rechargePath({ returnTo: '/chat/c1', requiredCredits: 50 })).toBe(
      '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1&required=50'
    );
  });

  it('redirectToRechargeFromError 命中才 push', () => {
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
    expect(router.push).toHaveBeenCalledWith(
      '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1&required=8'
    );
  });

  it('redirectToRecharge 直接按入参跳', () => {
    const router = { push: vi.fn() };
    redirectToRecharge(router, { returnTo: '/chat/c1' });
    expect(router.push).toHaveBeenCalledWith(
      '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1'
    );
  });
});
