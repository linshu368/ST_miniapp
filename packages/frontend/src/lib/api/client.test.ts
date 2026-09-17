import { describe, expect, it } from 'vitest';

import { toApiClientError } from './client';

describe('toApiClientError', () => {
  it('402 裸响应体：认出 insufficient_balance 并带出两个金额', () => {
    const error = toApiClientError(402, {
      error: {
        message: 'Insufficient credits: have 10, need 50',
        type: 'insufficient_balance',
        credits_required: 50,
        credits_available: 10,
      },
    });

    expect(error).toMatchObject({
      status: 402,
      code: 'insufficient_balance',
      balance: { creditsRequired: 50, creditsAvailable: 10 },
    });
    expect(error.message).toBe('Insufficient credits: have 10, need 50');
  });

  it('标准 envelope 仍走 error.code，不编造金额', () => {
    const error = toApiClientError(402, {
      success: false,
      error: { code: 'INSUFFICIENT_CREDITS', message: '星尘余额不足，请先充值后再切换付费模型' },
    });

    expect(error.status).toBe(402);
    expect(error.code).toBe('INSUFFICIENT_CREDITS');
    expect(error.balance).toBeUndefined();
    expect(error.message).toBe('星尘余额不足，请先充值后再切换付费模型');
  });

  it('无法识别的 body 退回泛化文案', () => {
    const error = toApiClientError(500, null);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('API error: 500');
  });
});
