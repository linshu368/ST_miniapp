import { describe, expect, it } from 'vitest';
import { parsePaymentPlansConfig, PaymentPlansConfigError } from './rechargeRules.js';

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
