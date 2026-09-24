import { describe, expect, it } from 'vitest';

import {
  advancedImageEntry,
  billingFailureAction,
  checkinRewardLines,
  checkoutButtonLabel,
  formatDiscountLabel,
  formatTierQuote,
  formatTierVipNote,
  modelSwitchFeedback,
  orderBenefitLabel,
  publishedDiscountRate,
  resolveCheckoutSelection,
  selectionKey,
  shouldShowVipEntryBadge,
  supportsVipRenewal,
  vipExpiryImpactCopy,
  vipExpiryLeadCopy,
  vipEntryLabel,
  vipPlanTitle,
} from './presentation';

describe('discount and price display', () => {
  it('formats a server rate without assuming 88 or 95', () => {
    expect(formatDiscountLabel(0.8)).toBe('80折');
    expect(formatDiscountLabel(1)).toBe('100折');
    expect(formatDiscountLabel(0)).toBeNull();
    expect(formatDiscountLabel(1.2)).toBeNull();
  });

  it('reads the published rate only when the catalog actually sent one', () => {
    expect(publishedDiscountRate([{ discount_rate: null }, { discount_rate: 0.8 }])).toBe(0.8);
    expect(publishedDiscountRate([{ discount_rate: null }])).toBeNull();
    expect(publishedDiscountRate(undefined)).toBeNull();
  });

  it('maps catalog quote fields and does not multiply a missing discount', () => {
    expect(
      formatTierQuote({
        original_credits: 12,
        discount_rate: 0.8,
        discounted_exact: 9.6,
        payable_credits: 10,
      })?.summary
    ).toBe('原价 12 星尘 × 80折 = 9.6，实扣 10 星尘/轮');
    expect(
      formatTierQuote({
        original_credits: 12,
        discount_rate: null,
        discounted_exact: null,
        payable_credits: 12,
      })?.summary
    ).toBe('当前价格 12 星尘/轮');
    expect(formatTierQuote({})).toBeNull();
  });

  it('adds the server quote to each tier without replacing its original description', () => {
    expect(
      formatTierVipNote({
        key: 'light',
        discount_rate: 0.95,
        discounted_exact: 14.25,
        payable_credits: 14,
      })
    ).toBe('免费优先，免费轮次不叠加 95折；付费轮次 VIP 95折 → 14.25，实扣 14 星尘/轮');
    expect(
      formatTierVipNote({
        key: 'standard',
        discount_rate: 0.95,
        discounted_exact: 4.75,
        payable_credits: 5,
      })
    ).toBe('VIP 95折 → 4.75，实扣 5 星尘/轮');
    expect(
      formatTierVipNote({
        key: 'premium',
        discount_rate: null,
        discounted_exact: null,
        payable_credits: 12,
      })
    ).toBeNull();
  });
});

describe('entry badge and membership label', () => {
  it('shows the one-time badge only for a known non-member who has not opened it', () => {
    expect(
      shouldShowVipEntryBadge({
        statusKnown: true,
        active: false,
        entryBadgeVisible: true,
        discountLabel: '80折',
      })
    ).toBe(true);
    expect(
      shouldShowVipEntryBadge({
        statusKnown: true,
        active: true,
        entryBadgeVisible: true,
        discountLabel: '80折',
      })
    ).toBe(false);
    expect(
      shouldShowVipEntryBadge({
        statusKnown: true,
        active: false,
        entryBadgeVisible: false,
        discountLabel: '80折',
      })
    ).toBe(false);
    expect(
      shouldShowVipEntryBadge({
        statusKnown: false,
        active: false,
        entryBadgeVisible: true,
        discountLabel: '80折',
      })
    ).toBe(false);
    expect(
      shouldShowVipEntryBadge({
        statusKnown: true,
        active: false,
        entryBadgeVisible: true,
        discountLabel: null,
      })
    ).toBe(false);
  });

  it('uses remaining days from status only while the membership is active', () => {
    expect(vipEntryLabel({ active: true, remaining_days: 12 })).toBe('VIP · 剩 12 天');
    expect(vipEntryLabel({ active: false, remaining_days: 3 })).toBe('VIP');
    expect(vipEntryLabel(null)).toBe('VIP');
  });

  it('formats the plan and expiry impact from server-owned benefits', () => {
    expect(vipPlanTitle('week')).toBe('VIP 周卡');
    expect(vipPlanTitle('month')).toBe('VIP 月卡');
    expect(vipPlanTitle(null)).toBe('VIP 会员');
    expect(
      vipExpiryImpactCopy({
        text_discount_rate: 0.95,
        checkin_base_credits: 60,
        checkin_vip_credits: 60,
      })
    ).toEqual({
      checkin: { extra: '+60 星尘', fallback: '每日 60' },
      discount: '95折',
    });
    expect(vipExpiryImpactCopy(undefined)).toEqual({ checkin: null, discount: null });
    expect(
      vipExpiryLeadCopy({
        body: '旧正文',
        metadata: {
          reminder_window: 'expires_today',
          observed_valid_until: '2026-09-19T16:00:00.000Z',
        },
      })
    ).toBe('你的 VIP 会员将于今日到期。');
    expect(
      vipExpiryLeadCopy({
        body: '旧正文',
        metadata: {
          reminder_window: 'expiring_soon',
          observed_valid_until: '2026-09-26T16:00:00.000Z',
        },
      })
    ).toBe('你的 VIP 会员将于 2026-09-27 到期。');
  });
});

describe('checkout selection', () => {
  const creditPlans = [{ id: 'starter', price_cents: 600 }];
  const vipPlans = [
    { id: 'week', price_cents: 1399, available: false },
    { id: 'month', price_cents: 2888, available: true },
  ];

  it('keeps credits and vip mutually exclusive', () => {
    expect(
      resolveCheckoutSelection({
        selectedKey: selectionKey('credits', 'starter'),
        creditPlans,
        vipPlans,
      })
    ).toMatchObject({ kind: 'credits', id: 'starter' });
    expect(
      resolveCheckoutSelection({
        selectedKey: selectionKey('vip', 'month'),
        creditPlans,
        vipPlans,
      })
    ).toMatchObject({ kind: 'vip', id: 'month', available: true });
    expect(
      resolveCheckoutSelection({
        selectedKey: selectionKey('credits', 'week'),
        creditPlans,
        vipPlans,
      })
    ).toBeNull();
  });

  it('labels the pay button from the single selected product', () => {
    const vip = resolveCheckoutSelection({
      selectedKey: selectionKey('vip', 'month'),
      creditPlans,
      vipPlans,
    });
    expect(
      checkoutButtonLabel({
        pending: false,
        selection: vip,
        vipActive: true,
        creditsButtonText: '立即支付',
        vipVerb: 'immediate',
      })
    ).toBe('立即续费 ¥28.88');
    expect(
      checkoutButtonLabel({
        pending: false,
        selection: resolveCheckoutSelection({
          selectedKey: selectionKey('vip', 'week'),
          creditPlans,
          vipPlans,
        }),
        vipActive: false,
        creditsButtonText: '立即支付',
      })
    ).toBe('VIP 购买暂未开放');
    expect(
      checkoutButtonLabel({
        pending: false,
        selection: resolveCheckoutSelection({
          selectedKey: selectionKey('credits', 'starter'),
          creditPlans,
          vipPlans,
        }),
        vipActive: true,
        creditsButtonText: '立即支付',
      })
    ).toBe('立即支付 ¥6');
  });
});

describe('check-in, model switch, and billing codes', () => {
  it('splits base and vip rewards when the server sent both', () => {
    expect(
      checkinRewardLines({ reward_credits: 120, base_reward_credits: 60, vip_reward_credits: 60 })
    ).toEqual(['基础签到 +60 星尘', 'VIP 加成 +60 星尘']);
    expect(checkinRewardLines({ reward_credits: 40 })).toEqual(['星尘 +40 已到账。']);
  });

  it('tells the user the next reply uses the new model while one is generating', () => {
    expect(modelSwitchFeedback(true)).toBe('模型已切换，下一条回复生效');
    expect(modelSwitchFeedback(false)).toBe('模型已切换');
  });

  it('maps stable error codes without reading the message', () => {
    expect(billingFailureAction('VIP_REQUIRED')).toEqual({ type: 'vip' });
    expect(billingFailureAction('image_vip_required')).toEqual({ type: 'vip' });
    expect(billingFailureAction('MAIN_CREDITS_INSUFFICIENT')).toEqual({ type: 'main_wallet' });
    expect(billingFailureAction('insufficient_balance')).toEqual({ type: 'recharge' });
    expect(billingFailureAction('TOTAL_CREDITS_INSUFFICIENT')).toEqual({ type: 'recharge' });
    expect(billingFailureAction('ADVANCED_IMAGE_UNAVAILABLE')).toEqual({ type: 'unavailable' });
    expect(billingFailureAction('标准模型需要会员')).toEqual({ type: 'unknown' });
    expect(billingFailureAction(undefined)).toEqual({ type: 'unknown' });
  });
});

describe('notifications, orders, and advanced image entry', () => {
  it('renews only when the notification carries a vip action', () => {
    expect(supportsVipRenewal({ kind: 'vip_expiry', action_path: '/vip' })).toBe(true);
    expect(supportsVipRenewal({ kind: null, action_path: '/vip' })).toBe(true);
    expect(supportsVipRenewal({ kind: null, action_path: null })).toBe(false);
  });

  it('labels vip orders from the snapshot instead of zero credits', () => {
    expect(
      orderBenefitLabel({
        product_type: 'vip',
        credits_amount: 0,
        bonus_credits: 0,
        vip_duration_days: 31,
        vip_bonus_credits: 3000,
      })
    ).toBe('31 天会员 · 赠送 3,000 专项星尘');
    expect(
      orderBenefitLabel({
        product_type: 'credits',
        credits_amount: 100,
        bonus_credits: 20,
      })
    ).toBe('120 星尘');
  });

  it('hides advanced image unless the server opened it or only locked it for vip', () => {
    expect(advancedImageEntry({ enabled: false, available: false, locked_reason: null })).toBe(
      'hidden'
    );
    expect(
      advancedImageEntry({
        enabled: true,
        available: false,
        locked_reason: 'ADVANCED_IMAGE_UNAVAILABLE',
      })
    ).toBe('hidden');
    expect(
      advancedImageEntry({ enabled: true, available: false, locked_reason: 'VIP_REQUIRED' })
    ).toBe('vip_locked');
    expect(advancedImageEntry({ enabled: true, available: true, locked_reason: null })).toBe(
      'open'
    );
  });
});
