import { describe, expect, it } from 'vitest';

import { quoteVipMediaPrice } from './media-pricing.js';

describe('quoteVipMediaPrice', () => {
  it('applies the published VIP rate and rounds the payable amount once', () => {
    expect(
      quoteVipMediaPrice({
        originalCredits: 15,
        originalPriceLabel: '15 星尘',
        vipActive: true,
        discountRate: 0.95,
        isFreeTrial: false,
      })
    ).toEqual({
      originalCredits: 15,
      payableCredits: 14,
      priceLabel: 'VIP · 95折 · 实扣 14 星尘',
      discountRate: 0.95,
      discountedExact: 14.25,
    });
  });

  it('keeps free trials and non-members at their existing pricing semantics', () => {
    expect(
      quoteVipMediaPrice({
        originalCredits: 50,
        originalPriceLabel: '50 星尘',
        vipActive: true,
        discountRate: 0.95,
        isFreeTrial: true,
      })
    ).toMatchObject({ payableCredits: 50, discountRate: null, discountedExact: null });
    expect(
      quoteVipMediaPrice({
        originalCredits: 120,
        originalPriceLabel: '120 星尘',
        vipActive: false,
        discountRate: 0.95,
        isFreeTrial: false,
      })
    ).toMatchObject({ payableCredits: 120, discountRate: null, discountedExact: null });
  });
});
