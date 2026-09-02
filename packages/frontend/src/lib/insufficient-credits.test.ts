/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-02 10:55:58
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-02 10:56:01
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';

import {
  buildInsufficientCreditsRechargePath,
  buildInsufficientCreditsRechargePathFromError,
  isInsufficientCreditsError,
  readCreditsRequired,
} from './insufficient-credits';

describe('insufficient credits redirect', () => {
  it('统一编码 reason、returnTo 与 required', () => {
    expect(
      buildInsufficientCreditsRechargePath({
        returnTo: '/chat/c 1?session=s&tab=voice',
        creditsRequired: 15,
      })
    ).toBe(
      '/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc+1%3Fsession%3Ds%26tab%3Dvoice&required=15'
    );
  });

  it('错误没有合法金额时不写 required', () => {
    expect(
      buildInsufficientCreditsRechargePathFromError(
        { code: 'insufficient_balance', balance: { creditsRequired: Number.NaN } },
        '/chat/c1'
      )
    ).toBe('/profile/recharge?reason=insufficient_credits&returnTo=%2Fchat%2Fc1');
  });

  it('识别两类既有错误码并读取金额', () => {
    expect(isInsufficientCreditsError({ code: 'insufficient_balance' })).toBe(true);
    expect(isInsufficientCreditsError({ code: 'INSUFFICIENT_CREDITS' })).toBe(true);
    expect(isInsufficientCreditsError({ code: 'CONFLICT' })).toBe(false);
    expect(readCreditsRequired({ balance: { creditsRequired: 50 } })).toBe(50);
  });
});
