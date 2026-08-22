import { describe, expect, it } from 'vitest';
import { DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG } from '@miniapp/shared';
import {
  parsePaymentPlansConfig,
  parsePaymentPromptDialogConfig,
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

describe('parsePaymentPlansConfig', () => {
  it('returns database-backed plans', () => {
    expect(parsePaymentPlansConfig([validPlan])).toEqual([validPlan]);
  });

  it('fails closed when runtime_config is missing or malformed', () => {
    expect(() => parsePaymentPlansConfig(undefined)).toThrow(PaymentPlansConfigError);
    expect(() => parsePaymentPlansConfig([])).toThrow(PaymentPlansConfigError);
    expect(() => parsePaymentPlansConfig([{ id: 'incomplete' }])).toThrow(PaymentPlansConfigError);
  });
});

describe('parsePaymentPromptDialogConfig', () => {
  it('returns a valid runtime configuration', () => {
    const config = {
      enabled: true,
      title: '关闭 VPN',
      description: '关闭后再继续。',
      confirm_text: '继续支付',
      accent_color: '#f59e0b',
    };

    expect(parsePaymentPromptDialogConfig(config)).toEqual(config);
  });

  it('falls back to the safe default for missing or malformed values', () => {
    expect(parsePaymentPromptDialogConfig(undefined)).toEqual(DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG);
    expect(parsePaymentPromptDialogConfig({ enabled: true })).toEqual(
      DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG
    );
  });
});
