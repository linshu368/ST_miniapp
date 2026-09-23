import { describe, expect, it } from 'vitest';

import {
  ADVANCED_IMAGE_UNAVAILABLE_ERROR_CODE,
  BillingGatingErrorCodeSchema,
  FEATURE_FREE_TRIAL_LIMIT,
  resolveFeatureFreeTrialLimit,
  GetModelCatalogDataSchema,
  PaymentProductTypeSchema,
  PublicModelCatalogSchema,
  VIP_PLAN_COMMERCIAL_TERMS,
  VIP_TEXT_DISCOUNT_RATE,
  VipPlanSchema,
  VipStatusSchema,
  WalletAmountSplitSchema,
  allocateWalletDebit,
  allocateWalletRefund,
  assertWalletPolicyForCapability,
  canonicalVipPlanTerms,
  createWalletAmountSplit,
  isConsistentWalletBalance,
  isFeatureFreeTrialExhausted,
  isVipActiveAt,
  isVipPlanId,
  paymentProductTypeForPlanId,
  quoteTextModelUsage,
  remainingVipDisplayDays,
  resolveBillableCapabilityRules,
  roundHalfUpToInteger,
  summarizeFeatureFreeTrialQuota,
} from '../index.js';
import type {
  GetPaymentPlansData,
  NotificationItem,
  PaymentOrder,
  PostDailyCheckinData,
  WalletSpendingRecord,
} from '../index.js';

const weekPlan = {
  id: 'week' as const,
  price_cents: 1399,
  duration_days: 7,
  bonus_credits: 0,
  title: '周卡',
  description: '7 天 VIP',
  badge_text: null,
  available: true,
};

const monthPlan = {
  id: 'month' as const,
  price_cents: 2888,
  duration_days: 31,
  bonus_credits: 3000,
  title: '月卡',
  description: '31 天 VIP，赠送专项星尘',
  badge_text: '赠送 3000',
  available: true,
};

const legacyPaymentOrder: PaymentOrder = {
  id: 'TG_1_1_a',
  status: 'completed',
  payment_type: 'wxpay',
  amount_cents: 600,
  credits_amount: 600,
  bonus_credits: 0,
  created_at: '2026-09-01T00:00:00.000Z',
  expires_at: '2026-09-01T00:30:00.000Z',
  paid_at: '2026-09-01T00:01:00.000Z',
  provider_transaction_id: 'wx_1',
  settled_by: 'webhook',
};

describe('VIP plans and membership', () => {
  it('keeps the canonical week and month terms as the safe default', () => {
    expect(VipPlanSchema.parse(weekPlan)).toMatchObject(VIP_PLAN_COMMERCIAL_TERMS.week);
    expect(VipPlanSchema.parse(monthPlan)).toMatchObject(VIP_PLAN_COMMERCIAL_TERMS.month);
    expect(canonicalVipPlanTerms('week').bonus_credits).toBe(0);
    expect(canonicalVipPlanTerms('month')).toEqual({
      id: 'month',
      price_cents: 2888,
      duration_days: 31,
      bonus_credits: 3000,
    });
  });

  it('accepts published plan terms inside the shared bounds and still rejects week bonus', () => {
    expect(
      VipPlanSchema.safeParse({ ...monthPlan, duration_days: 30, price_cents: 100 }).success
    ).toBe(true);
    expect(VipPlanSchema.safeParse({ ...weekPlan, price_cents: 1 }).success).toBe(true);
    expect(VipPlanSchema.safeParse({ ...weekPlan, bonus_credits: 3000 }).success).toBe(false);
    expect(VipPlanSchema.safeParse({ ...weekPlan, price_cents: 0 }).success).toBe(false);
    expect(VipPlanSchema.safeParse({ ...monthPlan, duration_days: 0 }).success).toBe(false);
    expect(VipPlanSchema.safeParse({ ...weekPlan, price_cents: 1.5 }).success).toBe(false);
  });

  it('treats remaining_days as display-only while activity uses valid_until', () => {
    const now = '2026-09-21T00:00:00.000Z';
    expect(remainingVipDisplayDays('2026-09-22T00:00:00.000Z', now)).toBe(1);
    expect(remainingVipDisplayDays('2026-09-21T00:00:01.000Z', now)).toBe(1);
    expect(remainingVipDisplayDays(now, now)).toBe(0);
    expect(remainingVipDisplayDays('2026-09-20T23:59:59.000Z', now)).toBe(0);
    expect(isVipActiveAt('2026-09-21T00:00:01.000Z', now)).toBe(true);
    expect(isVipActiveAt(now, now)).toBe(false);
    expect(isVipActiveAt(null, now)).toBe(false);
    expect(
      VipStatusSchema.parse({
        active: false,
        valid_from: null,
        valid_until: null,
        remaining_days: 0,
        last_plan_id: null,
        entry_badge_visible: true,
      }).entry_badge_visible
    ).toBe(true);
  });

  it('classifies week/month plan ids as VIP products without assuming credit catalogs', () => {
    expect(isVipPlanId('week')).toBe(true);
    expect(isVipPlanId('month')).toBe(true);
    expect(paymentProductTypeForPlanId('week')).toBe('vip');
    expect(paymentProductTypeForPlanId('plan-entry')).toBeNull();
    expect(PaymentProductTypeSchema.parse('credits')).toBe('credits');
  });
});

describe('text pricing quote', () => {
  it('keeps the runtime original price for non-VIP text usage', () => {
    const quote = quoteTextModelUsage({
      original_credits: 15,
      is_vip: false,
      is_free_round: false,
      tier: 'light',
    });
    expect(quote).toMatchObject({
      ok: true,
      value: {
        original_credits: 15,
        discount_applied: false,
        discount_rate: null,
        discounted_exact: 15,
        payable_credits: 15,
        wallet_policy: 'main_then_bonus',
        requires_vip: false,
      },
    });
  });

  it('applies 95% VIP text discount and rounds to an integer', () => {
    const light = quoteTextModelUsage({
      original_credits: 15,
      is_vip: true,
      is_free_round: false,
      tier: 'light',
    });
    const standard = quoteTextModelUsage({
      original_credits: 30,
      is_vip: true,
      is_free_round: false,
      tier: 'standard',
    });
    const premium = quoteTextModelUsage({
      original_credits: 50,
      is_vip: true,
      is_free_round: false,
      tier: 'premium',
    });

    expect(light).toMatchObject({
      ok: true,
      value: {
        discount_applied: true,
        discount_rate: VIP_TEXT_DISCOUNT_RATE,
        payable_credits: 14,
        wallet_policy: 'main_then_bonus',
        requires_vip: false,
      },
    });
    expect(standard).toMatchObject({
      ok: true,
      value: {
        payable_credits: 29,
        wallet_policy: 'main_only',
        requires_vip: true,
      },
    });
    expect(premium).toMatchObject({
      ok: true,
      value: {
        payable_credits: 48,
        wallet_policy: 'main_only',
        requires_vip: true,
      },
    });
  });

  it('uses an explicit published discount and rejects rates outside (0, 1]', () => {
    expect(
      quoteTextModelUsage({
        original_credits: 50,
        is_vip: true,
        is_free_round: false,
        tier: 'premium',
        discount_rate: 0.5,
      })
    ).toMatchObject({ ok: true, value: { discount_rate: 0.5, payable_credits: 25 } });
    expect(
      quoteTextModelUsage({
        original_credits: 15,
        is_vip: true,
        is_free_round: false,
        tier: 'light',
        discount_rate: 1,
      })
    ).toMatchObject({ ok: true, value: { payable_credits: 15 } });
    for (const discountRate of [0, 1.01, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        quoteTextModelUsage({
          original_credits: 15,
          is_vip: true,
          is_free_round: false,
          tier: 'light',
          discount_rate: discountRate,
        })
      ).toMatchObject({ ok: false, code: 'INVALID_PRICE' });
    }
  });

  it('prefers a free round over VIP discount', () => {
    expect(
      quoteTextModelUsage({
        original_credits: 50,
        is_vip: true,
        is_free_round: true,
        tier: 'premium',
      })
    ).toMatchObject({
      ok: true,
      value: {
        original_credits: 50,
        discount_applied: false,
        payable_credits: 0,
        requires_vip: true,
        wallet_policy: 'main_only',
      },
    });
  });

  it('rounds 0.5 boundaries half-up and rejects illegal prices', () => {
    expect(roundHalfUpToInteger(0.5)).toBe(1);
    expect(roundHalfUpToInteger(1.5)).toBe(2);
    expect(roundHalfUpToInteger(2.5)).toBe(3);
    expect(roundHalfUpToInteger(13.2)).toBe(13);
    expect(
      quoteTextModelUsage({
        original_credits: -1,
        is_vip: true,
        is_free_round: false,
        tier: 'light',
      }).ok
    ).toBe(false);
    expect(
      quoteTextModelUsage({
        original_credits: 15.5,
        is_vip: false,
        is_free_round: false,
        tier: 'light',
      })
    ).toMatchObject({ ok: false, code: 'INVALID_PRICE' });
  });
});

describe('wallet policy and splits', () => {
  it('selects wallet policy by capability', () => {
    expect(resolveBillableCapabilityRules('text_light')).toMatchObject({
      wallet_policy: 'main_then_bonus',
      requires_vip: false,
    });
    expect(resolveBillableCapabilityRules('text_standard')).toMatchObject({
      wallet_policy: 'main_only',
      requires_vip: true,
    });
    expect(resolveBillableCapabilityRules('text_premium')).toMatchObject({
      wallet_policy: 'main_only',
      requires_vip: true,
    });
    expect(resolveBillableCapabilityRules('image_basic')).toMatchObject({
      wallet_policy: 'main_only',
      requires_vip: false,
      free_trial_feature: 'basic_image',
      free_trial_limit: FEATURE_FREE_TRIAL_LIMIT,
    });
    expect(resolveBillableCapabilityRules('voice')).toMatchObject({
      wallet_policy: 'main_only',
      requires_vip: false,
      free_trial_feature: 'voice',
    });
    expect(resolveBillableCapabilityRules('image_advanced')).toMatchObject({
      wallet_policy: 'main_only',
      requires_vip: true,
      free_trial_feature: null,
      free_trial_limit: null,
    });
    expect(assertWalletPolicyForCapability('text_premium', 'main_then_bonus').ok).toBe(false);
    expect(assertWalletPolicyForCapability('text_light', 'main_then_bonus').ok).toBe(true);
  });

  it('requires main + bonus = total and rejects illegal splits', () => {
    expect(createWalletAmountSplit(10, 20)).toEqual({
      ok: true,
      value: { main_credits: 10, bonus_credits: 20, total_credits: 30 },
    });
    expect(createWalletAmountSplit(10, 20, 40)).toMatchObject({
      ok: false,
      code: 'INVALID_WALLET_SPLIT',
    });
    expect(
      WalletAmountSplitSchema.safeParse({ main_credits: 1, bonus_credits: 1, total_credits: 3 })
        .success
    ).toBe(false);
    expect(
      isConsistentWalletBalance({
        credits: 30,
        main_credits: 10,
        bonus_credits: 20,
        total_credits: 30,
      })
    ).toBe(true);
    expect(
      isConsistentWalletBalance({
        credits: 29,
        main_credits: 10,
        bonus_credits: 20,
        total_credits: 30,
      })
    ).toBe(false);
  });

  it('allocates light-text combination debit atomically and refunds the same split', () => {
    const combination = allocateWalletDebit({
      policy: 'main_then_bonus',
      amount: 13,
      main_credits: 10,
      bonus_credits: 20,
      debit_key: 'llm:msg-1',
    });
    expect(combination).toEqual({
      ok: true,
      value: {
        policy: 'main_then_bonus',
        debit_key: 'llm:msg-1',
        main_credits: 10,
        bonus_credits: 3,
        total_credits: 13,
      },
    });

    expect(
      allocateWalletDebit({
        policy: 'main_then_bonus',
        amount: 13,
        main_credits: 10,
        bonus_credits: 2,
        debit_key: 'llm:msg-1',
      })
    ).toMatchObject({ ok: false, code: 'TOTAL_CREDITS_INSUFFICIENT' });

    expect(
      allocateWalletDebit({
        policy: 'main_only',
        amount: 26,
        main_credits: 10,
        bonus_credits: 100,
        debit_key: 'llm:msg-2',
      })
    ).toMatchObject({ ok: false, code: 'MAIN_CREDITS_INSUFFICIENT' });

    expect(
      allocateWalletDebit({
        policy: 'main_only',
        amount: 26,
        main_credits: 26,
        bonus_credits: 0,
        debit_key: 'llm:msg-2',
      })
    ).toMatchObject({
      ok: true,
      value: { main_credits: 26, bonus_credits: 0, total_credits: 26, policy: 'main_only' },
    });

    expect(
      allocateWalletRefund({
        original_debit: { main_credits: 10, bonus_credits: 3, total_credits: 13 },
        refund_key: 'refund:llm:msg-1',
        debit_key: 'llm:msg-1',
      })
    ).toEqual({
      ok: true,
      value: {
        refund_key: 'refund:llm:msg-1',
        debit_key: 'llm:msg-1',
        main_credits: 10,
        bonus_credits: 3,
        total_credits: 13,
      },
    });
  });
});

describe('media free-trial public semantics', () => {
  it('distinguishes reserved, consumed and released without implementing a state machine', () => {
    const quota = summarizeFeatureFreeTrialQuota({
      feature: 'voice',
      facts: [
        { ordinal: 1, status: 'consumed' },
        { ordinal: 2, status: 'reserved' },
        { ordinal: 3, status: 'released' },
      ],
    });
    expect(quota).toEqual({
      ok: true,
      quota: {
        feature: 'voice',
        free_trial_limit: 3,
        free_trials_used: 1,
        free_trials_reserved: 1,
        free_trials_remaining: 1,
        next_trial_ordinal: 3,
      },
    });
    if (quota.ok) expect(isFeatureFreeTrialExhausted(quota.quota)).toBe(false);
  });

  it('keeps historical occupancy when the published limit moves between 0, 3 and 20', () => {
    const facts = [
      { ordinal: 1, status: 'consumed' as const },
      { ordinal: 2, status: 'consumed' as const },
      { ordinal: 3, status: 'consumed' as const },
    ];
    expect(summarizeFeatureFreeTrialQuota({ feature: 'voice', facts, limit: 0 })).toMatchObject({
      ok: true,
      quota: {
        free_trial_limit: 0,
        free_trials_used: 3,
        free_trials_remaining: 0,
        next_trial_ordinal: null,
      },
    });
    expect(summarizeFeatureFreeTrialQuota({ feature: 'voice', facts, limit: 3 })).toMatchObject({
      ok: true,
      quota: { free_trial_limit: 3, free_trials_remaining: 0, next_trial_ordinal: null },
    });
    expect(
      summarizeFeatureFreeTrialQuota({ feature: 'basic_image', facts, limit: 20 })
    ).toMatchObject({
      ok: true,
      quota: { free_trial_limit: 20, free_trials_remaining: 17, next_trial_ordinal: 4 },
    });
    expect(summarizeFeatureFreeTrialQuota({ feature: 'voice', facts, limit: 21 })).toMatchObject({
      ok: false,
      code: 'FEATURE_FREE_TRIAL_INVALID_STATE',
    });
    expect(
      summarizeFeatureFreeTrialQuota({
        feature: 'voice',
        facts: [{ ordinal: 21, status: 'consumed' }],
        limit: 20,
      })
    ).toMatchObject({ ok: false, code: 'FEATURE_FREE_TRIAL_INVALID_STATE' });
  });

  it('treats advanced image as VIP-only with no free trials and exposes shared error codes', () => {
    const exhausted = summarizeFeatureFreeTrialQuota({
      feature: 'basic_image',
      facts: [
        { ordinal: 1, status: 'consumed' },
        { ordinal: 2, status: 'consumed' },
        { ordinal: 3, status: 'reserved' },
      ],
    });
    expect(exhausted).toMatchObject({
      ok: true,
      quota: {
        free_trials_used: 2,
        free_trials_reserved: 1,
        free_trials_remaining: 0,
        next_trial_ordinal: null,
      },
    });
    if (exhausted.ok) expect(isFeatureFreeTrialExhausted(exhausted.quota)).toBe(true);
    expect(resolveBillableCapabilityRules('image_advanced').free_trial_feature).toBeNull();
    expect(BillingGatingErrorCodeSchema.parse('VIP_REQUIRED')).toBe('VIP_REQUIRED');
    expect(BillingGatingErrorCodeSchema.parse(ADVANCED_IMAGE_UNAVAILABLE_ERROR_CODE)).toBe(
      'ADVANCED_IMAGE_UNAVAILABLE'
    );
    expect(
      summarizeFeatureFreeTrialQuota({
        feature: 'voice',
        facts: [
          { ordinal: 1, status: 'reserved' },
          { ordinal: 1, status: 'consumed' },
        ],
      })
    ).toMatchObject({ ok: false, code: 'FEATURE_FREE_TRIAL_CONFLICT' });
  });

  it('keeps a published zero and falls back when the limit is outside 0..20', () => {
    expect(resolveFeatureFreeTrialLimit(0)).toBe(0);
    expect(resolveFeatureFreeTrialLimit(20)).toBe(20);
    expect(resolveFeatureFreeTrialLimit(21)).toBe(3);
    expect(resolveFeatureFreeTrialLimit('3')).toBe(3);
  });

  it('summarizes quota against the configured media free-trial limit', () => {
    const quota = summarizeFeatureFreeTrialQuota({
      feature: 'basic_image',
      limit: 5,
      facts: [
        { ordinal: 1, status: 'consumed' },
        { ordinal: 3, status: 'reserved' },
        { ordinal: 6, status: 'consumed' },
      ],
    });

    expect(quota).toEqual({
      ok: true,
      quota: {
        feature: 'basic_image',
        free_trial_limit: 5,
        free_trials_used: 1,
        free_trials_reserved: 1,
        free_trials_remaining: 3,
        next_trial_ordinal: 2,
      },
    });
  });
});

describe('additive compatibility for existing DTOs', () => {
  it('keeps legacy payment, wallet, catalog and notification shapes assignable', () => {
    const plans: GetPaymentPlansData = {
      plans: [
        {
          id: 'plan-entry',
          price_cents: 600,
          original_price_cents: null,
          credits_amount: 600,
          bonus_credits: 0,
          variant: 'entry',
          badge_text: null,
          sub_copy: '初次邂逅',
          highlight_text: null,
        },
      ],
      page_config: {
        title: '星尘商店',
        description: '说明',
        button_text: '支付',
        theme_color: '#ec4899',
        balance_color: '#8b5cf6',
        selected_plan_color: '#f59e0b',
        badge_color: '#6366f1',
        button_color: '#ec4899',
        pending_arrival_hint: '完成付款后积分将自动到账，通常不超过 3 分钟',
      },
      payment_prompt_dialog_config: {
        enabled: true,
        title: '支付前请先关闭 VPN',
        description: '请关闭 VPN 后再继续支付。',
        confirm_text: '已关闭VPN，继续支付',
        footer_note: '确认后打开外部浏览器。',
        accent_color: '#f59e0b',
      },
      insufficient_credits_notice: '余额不足',
    };
    const spending: WalletSpendingRecord = {
      id: 'sp-1',
      model_id: 'flash',
      model_display_name: '轻量',
      charged_amount: 15,
      status: 'charged',
      finish_reason: 'stop',
      reply_outcome: 'complete',
      status_label: '已扣费',
      created_at: '2026-09-01T00:00:00.000Z',
    };
    const checkin: PostDailyCheckinData = {
      wallet: {
        credits: 30,
        main_credits: 10,
        bonus_credits: 20,
        total_credits: 30,
        first_paid_at: null,
        last_paid_at: null,
        total_paid_amount: '0.00',
      },
      checkin: {
        claimed_at: '2026-09-21T00:00:00.000Z',
        next_claim_at: '2026-09-22T00:00:00.000Z',
        reward_credits: 40,
      },
    };
    const notification: NotificationItem = {
      id: 'n1',
      scope: 'official',
      category: 'system',
      title: '公告',
      body: '正文',
      published_at: '2026-09-01T00:00:00.000Z',
      created_at: '2026-09-01T00:00:00.000Z',
      is_read: false,
    };

    expect(legacyPaymentOrder.product_type).toBeUndefined();
    expect(plans.vip_plans).toBeUndefined();
    expect(spending.main_delta).toBeUndefined();
    expect(checkin.checkin.base_reward_credits).toBeUndefined();
    expect(notification.kind).toBeUndefined();
    expect(
      PublicModelCatalogSchema.parse({
        default_model_id: 'flash',
        tiers: [
          {
            key: 'light',
            label: '轻量',
            color: '#ffffff',
            cost_hint: '低消耗',
            sort_order: 0,
            models: [
              { id: 'flash', display_name: 'Flash', tagline: '快', is_free: true, sort_order: 0 },
            ],
          },
        ],
      }).tiers[0]
    ).not.toHaveProperty('requires_vip');
    expect(
      GetModelCatalogDataSchema.parse({
        catalog: {
          default_model_id: 'flash',
          tiers: [
            {
              key: 'light',
              label: '轻量',
              color: '#ffffff',
              cost_hint: '低消耗',
              sort_order: 0,
              models: [
                { id: 'flash', display_name: 'Flash', tagline: '快', is_free: true, sort_order: 0 },
              ],
            },
          ],
        },
        selected_model_id: 'flash',
        selected_openrouter_model_id: 'google/gemini-flash',
        catalog_version: 1,
      })
    ).not.toHaveProperty('vip_status');
  });
});
