import { describe, expect, it } from 'vitest';
import { PaymentPlansSchema } from '../api/payment.js';

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
