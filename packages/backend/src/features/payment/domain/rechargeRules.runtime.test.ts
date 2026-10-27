import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
} from '@miniapp/shared';

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
  PAYMENT_PROMPT_DIALOG_CONFIG_KEY,
  PaymentPlansConfigError,
  RECHARGE_PAGE_CONFIG_KEY,
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
    const pageConfig = { ...DEFAULT_RECHARGE_PAGE_CONFIG, title: '充值页' };
    const promptConfig = {
      enabled: true,
      title: '支付提示',
      description: '请确认支付环境。',
      confirm_text: '继续',
      footer_note: '支付完成后返回。',
      accent_color: '#f59e0b',
    };
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
        [RECHARGE_PAGE_CONFIG_KEY, entry(pageConfig)],
        [PAYMENT_PROMPT_DIALOG_CONFIG_KEY, entry(promptConfig)],
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
      pageConfig,
      paymentPromptDialogConfig: promptConfig,
      insufficientCreditsNotice: '请先充值',
    });
    expect(mocks.fetchRuntimeConfigEntries).toHaveBeenCalledOnce();
    expect(mocks.fetchRuntimeConfigEntries.mock.calls[0]?.[0]).toEqual([
      PAYMENT_PLANS_CONFIG_KEY,
      RECHARGE_PAGE_CONFIG_KEY,
      PAYMENT_PROMPT_DIALOG_CONFIG_KEY,
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

  it('keeps safe defaults for missing non-critical page configuration', async () => {
    mocks.fetchRuntimeConfigEntries.mockResolvedValue(
      new Map([[PAYMENT_PLANS_CONFIG_KEY, entry([validPlan])]])
    );

    const result = await getPaymentPageRuntimeConfig();
    expect(result.pageConfig).toEqual(DEFAULT_RECHARGE_PAGE_CONFIG);
    expect(result.paymentPromptDialogConfig).toEqual(DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG);
    expect(result.insufficientCreditsNotice).toBe('当前星尘积分不足，需要先购买积分才能继续聊天。');
  });
});
