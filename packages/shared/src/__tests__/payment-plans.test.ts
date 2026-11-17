import { describe, expect, it } from 'vitest';
import {
  PaymentChannelsConfigSchema,
  PaymentPlansRuntimeConfigSchema,
  PaymentPlansSchema,
} from '../api/payment.js';

const plan = {
  id: 'plan-entry',
  price_cents: 600,
  original_price_cents: null,
  credits_amount: 600,
  bonus_credits: 0,
  variant: 'entry',
  badge_text: null,
  sub_copy: '初次邂逅',
  highlight_text: null,
};

describe('PaymentPlansSchema', () => {
  it('accepts a nonempty unique plan catalog', () => {
    expect(PaymentPlansSchema.parse([plan])).toEqual([plan]);
  });

  it('rejects missing plans and duplicate stable ids', () => {
    expect(PaymentPlansSchema.safeParse(undefined).success).toBe(false);
    expect(PaymentPlansSchema.safeParse([]).success).toBe(false);
    expect(PaymentPlansSchema.safeParse([plan, plan]).success).toBe(false);
  });
});

describe('PaymentChannelsConfigSchema', () => {
  it('requires an enabled default channel', () => {
    expect(
      PaymentChannelsConfigSchema.safeParse({
        alipay_enabled: true,
        wxpay_enabled: false,
        default_payment_type: 'alipay',
      }).success
    ).toBe(true);
    expect(
      PaymentChannelsConfigSchema.safeParse({
        alipay_enabled: true,
        wxpay_enabled: false,
        default_payment_type: 'wxpay',
      }).success
    ).toBe(false);
  });

  it('normalizes a legacy plan array to the alipay-only entry policy', () => {
    expect(PaymentPlansRuntimeConfigSchema.parse([plan])).toMatchObject({
      plans: [plan],
      payment_channels: {
        alipay_enabled: true,
        wxpay_enabled: false,
        default_payment_type: 'alipay',
      },
    });
  });
});
