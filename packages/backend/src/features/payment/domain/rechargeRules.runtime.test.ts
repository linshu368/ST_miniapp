import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchRuntimeConfigEntries: vi.fn(),
  fetchRuntimeConfigEntry: vi.fn(),
}));

vi.mock('../../../platform/runtime-config.js', () => ({
  fetchRuntimeConfigEntries: mocks.fetchRuntimeConfigEntries,
  fetchRuntimeConfigEntry: mocks.fetchRuntimeConfigEntry,
}));

import {
  getPaymentPageRuntimeConfig,
  INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY,
  PAYMENT_PLANS_CONFIG_KEY,
  PaymentPlansConfigError,
} from './rechargeRules.js';

const validPlan = {
  id: 'plan-entry',
  price_cents: 600,
  original_price_cents: null,
  credits_amount: 600,
  bonus_credits: 0,
  variant: 'entry',
  badge_text: null,
  sub_copy: null,
  highlight_text: null,
};

function entry(value: unknown, textValue: string | null = null) {
  return { value, textValue, version: 1 };
}

describe('getPaymentPageRuntimeConfig', () => {
  beforeEach(() => {
    mocks.fetchRuntimeConfigEntries.mockReset();
    mocks.fetchRuntimeConfigEntry.mockReset();
  });

  it('loads the payment page configuration in one batch', async () => {
    mocks.fetchRuntimeConfigEntries.mockResolvedValue(
      new Map([
        [
          PAYMENT_PLANS_CONFIG_KEY,
          entry({
            plans: [validPlan],
            payment_channels: {
              alipay_enabled: true,
              wxpay_enabled: false,
              default_payment_type: 'alipay',
            },
          }),
        ],
        [INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY, entry(null, '请先充值')],
      ])
    );

    await expect(getPaymentPageRuntimeConfig()).resolves.toEqual({
      plans: [validPlan],
      paymentChannels: {
        alipay_enabled: true,
        wxpay_enabled: false,
        default_payment_type: 'alipay',
      },
      insufficientCreditsNotice: '请先充值',
    });
    expect(mocks.fetchRuntimeConfigEntries).toHaveBeenCalledOnce();
    expect(mocks.fetchRuntimeConfigEntries.mock.calls[0]?.[0]).toEqual([
      PAYMENT_PLANS_CONFIG_KEY,
      INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY,
    ]);
  });

  it('fails closed when the plans entry is missing or invalid', async () => {
    mocks.fetchRuntimeConfigEntries.mockResolvedValue(new Map());
    await expect(getPaymentPageRuntimeConfig()).rejects.toBeInstanceOf(PaymentPlansConfigError);

    mocks.fetchRuntimeConfigEntries.mockResolvedValue(
      new Map([[PAYMENT_PLANS_CONFIG_KEY, entry([{ id: 'incomplete' }])]])
    );
    await expect(getPaymentPageRuntimeConfig()).rejects.toBeInstanceOf(PaymentPlansConfigError);
  });

  it('keeps the default insufficient-credits notice when none is configured', async () => {
    mocks.fetchRuntimeConfigEntries.mockResolvedValue(
      new Map([[PAYMENT_PLANS_CONFIG_KEY, entry([validPlan])]])
    );

    const result = await getPaymentPageRuntimeConfig();
    expect(result.insufficientCreditsNotice).toBe('当前星尘积分不足，需要先购买积分才能继续聊天。');
  });
});
