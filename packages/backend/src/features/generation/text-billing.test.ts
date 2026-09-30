import { describe, expect, it } from 'vitest';
import { ModelCatalogSchema, type ModelCatalog } from '@miniapp/shared';
import {
  coverageForTextWallet,
  frozenLlmChargeMetadata,
  presentTextModelCatalog,
  quoteAcceptedTextUsage,
  resolveTextModelSelection,
  TextModelAccessError,
} from './text-billing.js';

const PRICING = { freeQuotaExhausted: 10, light: 15, standard: 30, premium: 50 };

const CATALOG: ModelCatalog = ModelCatalogSchema.parse({
  default_model_id: 'light-model',
  tiers: [
    {
      tier: 'light',
      label: '轻量',
      color: '#111111',
      cost_hint: '档',
      sort_order: 0,
      models: [
        {
          id: 'light-model',
          openrouter_model_id: 'vendor/light',
          display_name: '轻量',
          tagline: '说明',
          is_free: false,
          enabled: true,
          sort_order: 0,
        },
      ],
    },
    {
      tier: 'standard',
      label: '标准',
      color: '#222222',
      cost_hint: '档',
      sort_order: 1,
      models: [
        {
          id: 'standard-model',
          openrouter_model_id: 'vendor/standard',
          display_name: '标准',
          tagline: '说明',
          is_free: false,
          enabled: true,
          sort_order: 0,
        },
      ],
    },
    {
      tier: 'premium',
      label: '旗舰',
      color: '#333333',
      cost_hint: '档',
      sort_order: 2,
      models: [
        {
          id: 'premium-model',
          openrouter_model_id: 'vendor/premium',
          display_name: '旗舰',
          tagline: '说明',
          is_free: false,
          enabled: true,
          sort_order: 0,
        },
      ],
    },
  ],
});

describe('quoteAcceptedTextUsage', () => {
  it('免费轮优先，VIP 也不叠折扣', () => {
    const quote = quoteAcceptedTextUsage({
      originalCredits: PRICING.premium,
      tier: 'premium',
      isVip: true,
      isFreeRound: true,
      vipValidUntil: '2099-01-01T00:00:00.000Z',
    });
    expect(quote.payable_credits).toBe(0);
    expect(quote.discount_rate).toBeNull();
    expect(quote.original_credits).toBe(50);
    expect(quote.wallet_policy).toBe('main_only');
  });

  it('三档 VIP 折扣来自传入原价，取整为 14/29/48', () => {
    expect(
      quoteAcceptedTextUsage({
        originalCredits: PRICING.light,
        tier: 'light',
        isVip: true,
        isFreeRound: false,
        vipValidUntil: null,
      }).payable_credits
    ).toBe(14);
    expect(
      quoteAcceptedTextUsage({
        originalCredits: PRICING.standard,
        tier: 'standard',
        isVip: true,
        isFreeRound: false,
        vipValidUntil: null,
      })
    ).toMatchObject({ payable_credits: 29, wallet_policy: 'main_only', requires_vip: true });
    expect(
      quoteAcceptedTextUsage({
        originalCredits: PRICING.premium,
        tier: 'premium',
        isVip: true,
        isFreeRound: false,
        vipValidUntil: null,
      }).payable_credits
    ).toBe(48);
  });

  it('非 VIP 保持原价，轻量仍可使用两钱包', () => {
    const quote = quoteAcceptedTextUsage({
      originalCredits: PRICING.light,
      tier: 'light',
      isVip: false,
      isFreeRound: false,
      vipValidUntil: null,
    });
    expect(quote.payable_credits).toBe(15);
    expect(quote.discount_rate).toBeNull();
    expect(quote.wallet_policy).toBe('main_then_bonus');
    expect(quote.requires_vip).toBe(false);
  });
});

describe('coverageForTextWallet', () => {
  it('只有专项余额时，旗舰整笔拒绝，轻量可以补足', () => {
    expect(
      coverageForTextWallet({
        policy: 'main_only',
        payableCredits: 30,
        mainCredits: 0,
        bonusCredits: 80,
      })
    ).toEqual({ ok: false, code: 'MAIN_CREDITS_INSUFFICIENT', available: 0 });
    expect(
      coverageForTextWallet({
        policy: 'main_then_bonus',
        payableCredits: 30,
        mainCredits: 0,
        bonusCredits: 80,
      })
    ).toEqual({ ok: true });
  });

  it('两钱包合计仍不足时整笔失败', () => {
    expect(
      coverageForTextWallet({
        policy: 'main_then_bonus',
        payableCredits: 30,
        mainCredits: 10,
        bonusCredits: 5,
      })
    ).toEqual({ ok: false, code: 'TOTAL_CREDITS_INSUFFICIENT', available: 15 });
  });
});

describe('resolveTextModelSelection', () => {
  it('VIP 到期后标准/旗舰回落轻量', () => {
    const selected = resolveTextModelSelection({
      catalog: CATALOG,
      persistedModelId: 'premium-model',
      vipActive: false,
    });
    expect(selected).toMatchObject({
      modelId: 'light-model',
      tier: 'light',
      vipFallback: true,
    });
  });

  it('有效 VIP 保持旗舰', () => {
    const selected = resolveTextModelSelection({
      catalog: CATALOG,
      persistedModelId: 'premium-model',
      vipActive: true,
    });
    expect(selected.modelId).toBe('premium-model');
    expect(selected.vipFallback).toBe(false);
  });

  it('没有轻量档时不拿旗舰顶上', () => {
    const premiumOnly = ModelCatalogSchema.parse({
      default_model_id: 'premium-model',
      tiers: CATALOG.tiers.filter((tier) => tier.tier === 'premium'),
    });
    expect(() =>
      resolveTextModelSelection({
        catalog: premiumOnly,
        persistedModelId: 'premium-model',
        vipActive: false,
      })
    ).toThrow(TextModelAccessError);
  });
});

describe('frozen quote', () => {
  it('目录改价不会改写已经固化的实付', () => {
    const accepted = quoteAcceptedTextUsage({
      originalCredits: PRICING.premium,
      tier: 'premium',
      isVip: true,
      isFreeRound: false,
      vipValidUntil: '2099-01-01T00:00:00.000Z',
    });
    const metadata = frozenLlmChargeMetadata({
      fixed_deduction: accepted.payable_credits,
      fixed_deduction_category: 'premium',
      original_credits: accepted.original_credits,
      discount_rate: accepted.discount_rate,
      payable_credits: accepted.payable_credits,
      wallet_policy: accepted.wallet_policy,
      vip_active: true,
      vip_valid_until: accepted.vip_valid_until,
      model_tier: accepted.model_tier,
    });
    const later = quoteAcceptedTextUsage({
      originalCredits: 80,
      tier: 'premium',
      isVip: false,
      isFreeRound: false,
      vipValidUntil: null,
    });
    expect(metadata.payable_credits).toBe(48);
    expect(later.payable_credits).toBe(80);
    expect(metadata.payable_credits).not.toBe(later.payable_credits);
  });
});

describe('presentTextModelCatalog', () => {
  it('用运行时原价和当前 VIP 填充档位，不把非 VIP 标成已折扣', () => {
    const catalog = presentTextModelCatalog({
      catalog: CATALOG,
      pricing: PRICING,
      vip: { active: false, remaining_days: 0, valid_until: null },
    });
    const premium = catalog.tiers.find((tier) => tier.key === 'premium');
    expect(premium).toMatchObject({
      requires_vip: true,
      locked: true,
      original_credits: 50,
      payable_credits: 50,
      discount_rate: null,
      wallet_policy: 'main_only',
    });
  });
});
