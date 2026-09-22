import { describe, expect, it, vi } from 'vitest';
import { checkWalletBalance, resolveBillingPlan } from './precheck.js';
import type { LlmPricingConfig, ModelBillingContext } from '../../platform/model-tiers.js';
import type { GenerationLogger } from './types.js';

function fakeLogger(): GenerationLogger {
  const sink = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
    child: vi.fn(),
  };
  return Object.assign({ ...sink }, { biz: sink, sys: sink }) as unknown as GenerationLogger;
}

const PRICING: LlmPricingConfig = {
  version: 7,
  fixedDeduction: { freeQuotaExhausted: 10, light: 15, standard: 30, premium: 50 },
};

const PAID_MODEL: ModelBillingContext = {
  modelId: 'anthropic-claude-sonnet-4-5',
  modelDisplayName: 'Claude Sonnet 4.5',
  openRouterModelId: 'anthropic/claude-sonnet-4.5',
  modelTier: 'premium',
  catalogVersion: 12,
  isFree: false,
};

const FREE_MODEL: ModelBillingContext = {
  ...PAID_MODEL,
  modelId: 'gemini-flash-lite',
  modelDisplayName: 'Gemini Flash Lite',
  openRouterModelId: 'google/gemini-3.1-flash-lite',
  modelTier: 'light',
  isFree: true,
};

const INACTIVE = { active: false, validUntil: null };

describe('resolveBillingPlan', () => {
  it('计费快照的字段与 chat_history 落库口径逐项对齐', () => {
    const plan = resolveBillingPlan({
      chargeId: 'charge-1',
      billing: PAID_MODEL,
      isFreeRound: false,
      pricing: PRICING,
      entitlement: INACTIVE,
      log: fakeLogger(),
    });

    expect(plan.fixedDeduction).toEqual({ amount: 50, category: 'premium' });
    expect(plan.snapshot).toEqual({
      charge_id: 'charge-1',
      model_id: 'anthropic-claude-sonnet-4-5',
      model_display_name: 'Claude Sonnet 4.5',
      model_markup: 1,
      fixed_deduction: 50,
      fixed_deduction_category: 'premium',
      catalog_version: 12,
      pricing_config_version: 7,
      exchange_rate: 1,
      original_credits: 50,
      discount_rate: null,
      discounted_exact: 50,
      payable_credits: 50,
      wallet_policy: 'main_only',
      requires_vip: true,
      vip_active: false,
      vip_valid_until: null,
      model_tier: 'premium',
    });
  });

  it('有效 VIP 按运行时原价打 95 折后写入实付，不改 category', () => {
    const plan = resolveBillingPlan({
      chargeId: 'charge-vip',
      billing: PAID_MODEL,
      isFreeRound: false,
      pricing: PRICING,
      entitlement: { active: true, validUntil: '2099-01-01T00:00:00.000Z' },
      log: fakeLogger(),
    });
    expect(plan.fixedDeduction).toEqual({ amount: 48, category: 'premium' });
    expect(plan.snapshot.original_credits).toBe(50);
    expect(plan.snapshot.payable_credits).toBe(48);
    expect(plan.snapshot.discount_rate).toBe(0.95);
    expect(plan.snapshot.wallet_policy).toBe('main_only');
  });

  it('快照用 0/1 标记本轮是否走免费额度', () => {
    const freeRound = resolveBillingPlan({
      chargeId: 'charge-2',
      billing: FREE_MODEL,
      isFreeRound: true,
      pricing: PRICING,
      entitlement: { active: true, validUntil: '2099-01-01T00:00:00.000Z' },
      log: fakeLogger(),
    });
    expect(freeRound.snapshot.model_markup).toBe(0);
    expect(freeRound.fixedDeduction).toEqual({ amount: 0, category: 'free_quota' });
    expect(freeRound.snapshot.original_credits).toBe(10);
    expect(freeRound.snapshot.discount_rate).toBeNull();
    expect(freeRound.snapshot.wallet_policy).toBe('main_then_bonus');

    const exhausted = resolveBillingPlan({
      chargeId: 'charge-3',
      billing: FREE_MODEL,
      isFreeRound: false,
      pricing: PRICING,
      entitlement: INACTIVE,
      log: fakeLogger(),
    });
    expect(exhausted.snapshot.model_markup).toBe(1);
    expect(exhausted.fixedDeduction).toEqual({ amount: 10, category: 'free_quota_exhausted' });
    expect(exhausted.snapshot.payable_credits).toBe(10);
  });

  it('付费模型档位未知时回落 standard 并告警', () => {
    const log = fakeLogger();
    const plan = resolveBillingPlan({
      chargeId: 'charge-4',
      billing: { ...PAID_MODEL, modelTier: null },
      isFreeRound: false,
      pricing: PRICING,
      entitlement: INACTIVE,
      log,
    });

    expect(plan.fixedDeduction).toEqual({ amount: 30, category: 'standard_fallback' });
    expect(plan.snapshot.wallet_policy).toBe('main_only');
    expect(plan.snapshot.requires_vip).toBe(true);
    expect(log.sys.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'llm.billing.unknown_paid_tier' }),
      expect.any(String)
    );
  });
});

describe('checkWalletBalance', () => {
  it('扣费额为 0 时跳过钱包查询，免费轮不因钱包不可读而中断', async () => {
    const log = fakeLogger();
    await expect(
      checkWalletBalance({
        userId: 'user-1',
        requiredAmount: 0,
        walletPolicy: 'main_then_bonus',
        openRouterModelId: FREE_MODEL.openRouterModelId,
        log,
      })
    ).resolves.toEqual({ ok: true });
    expect(log.biz.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'llm.balance.check_skipped' }),
      expect.any(String)
    );
  });
});
