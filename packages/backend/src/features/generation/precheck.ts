/**
 * backend / features / generation / precheck.ts
 *
 * 定档扣费额与余额预检。
 *
 * 预检必须在调用上游之前完成：余额不足要在 SSE 首字节写出前判定，这样调用方还能用
 * HTTP 402 收口。响应头一旦发出就只能降级成流内 error 事件，前端处理成本高一截。
 * 本模块只做判定、不构造响应。
 */

import type { WalletDebitPolicy } from '@miniapp/shared';
import { resolveFixedDeduction, type FixedDeductionDecision } from '../billing/usage-pricing.js';
import type { FixedDeductionCategory } from '../billing/usage-pricing.js';
import type { LlmPricingConfig, ModelBillingContext } from '../../platform/model-tiers.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import type { GenerationLogger } from './types.js';
import {
  coverageForTextWallet,
  originalCreditsForDecision,
  quoteAcceptedTextUsage,
  tierForTextQuote,
  type TextEntitlement,
} from './text-billing.js';

let walletRepository: MiniappWalletRepository | null = null;

function wallets(): MiniappWalletRepository {
  return (walletRepository ??= new MiniappWalletRepository());
}

/** 落 chat_history 与 charge 的计费快照，字段名与 ChatHistoryEntry 对齐，可直接展开。 */
export interface BillingSnapshot {
  charge_id: string;
  model_id: string | null;
  model_display_name: string;
  /** 0 = 本轮走免费额度；1 = 本轮按定档扣费。仅写入历史审计列。 */
  model_markup: number;
  fixed_deduction: number;
  fixed_deduction_category: FixedDeductionCategory;
  catalog_version: number;
  pricing_config_version: number;
  /** charge_llm_usage 仍要求正数；定档扣费不再使用汇率。 */
  exchange_rate: number;
  original_credits: number;
  discount_rate: number | null;
  discounted_exact: number;
  payable_credits: number;
  wallet_policy: WalletDebitPolicy;
  requires_vip: boolean;
  vip_active: boolean;
  vip_valid_until: string | null;
  model_tier: string;
  vip_discount_config_version: number | null;
}

export interface BillingPlan {
  chargeId: string;
  fixedDeduction: FixedDeductionDecision;
  snapshot: BillingSnapshot;
}

/**
 * 结算本轮的定档扣费额并固化计费快照。
 *
 * isFreeRound 来自免费额度预留结果：免费模型在额度内为 true，额度耗尽后为 false。
 */
export function resolveBillingPlan(input: {
  chargeId: string;
  billing: ModelBillingContext;
  isFreeRound: boolean;
  pricing: LlmPricingConfig;
  entitlement: TextEntitlement;
  discountRate?: number;
  discountConfigVersion?: number | null;
  log: GenerationLogger;
}): BillingPlan {
  const { chargeId, billing, isFreeRound, pricing, entitlement, log } = input;

  const fixedDeduction = resolveFixedDeduction({
    isFreeModel: billing.isFree,
    isFreeRound,
    modelTier: billing.modelTier,
    config: pricing.fixedDeduction,
  });
  if (fixedDeduction.category === 'standard_fallback') {
    log.sys.warn(
      {
        event: 'llm.billing.unknown_paid_tier',
        model: billing.openRouterModelId,
        modelTier: billing.modelTier,
        fixedDeduction: fixedDeduction.amount,
      },
      'unknown paid model tier, using standard fixed deduction'
    );
  }

  const tier = tierForTextQuote(billing.modelTier);
  // 免费轮把原价记在快照里，实付为 0，避免和 VIP 折扣叠在一起。
  const quote = quoteAcceptedTextUsage({
    originalCredits: originalCreditsForDecision({
      category: fixedDeduction.category,
      undiscountedAmount: fixedDeduction.amount,
      config: pricing.fixedDeduction,
    }),
    tier,
    isVip: entitlement.active,
    isFreeRound: fixedDeduction.category === 'free_quota',
    vipValidUntil: entitlement.validUntil,
    ...(input.discountRate === undefined ? {} : { discountRate: input.discountRate }),
    discountConfigVersion: input.discountConfigVersion ?? null,
  });

  return {
    chargeId,
    fixedDeduction: { amount: quote.payable_credits, category: fixedDeduction.category },
    snapshot: {
      charge_id: chargeId,
      model_id: billing.modelId,
      model_display_name: billing.modelDisplayName,
      model_markup: isFreeRound ? 0 : 1,
      fixed_deduction: quote.payable_credits,
      fixed_deduction_category: fixedDeduction.category,
      catalog_version: billing.catalogVersion,
      pricing_config_version: pricing.version,
      exchange_rate: 1,
      original_credits: quote.original_credits,
      discount_rate: quote.discount_rate,
      discounted_exact: quote.discounted_exact,
      payable_credits: quote.payable_credits,
      wallet_policy: quote.wallet_policy,
      requires_vip: quote.requires_vip,
      vip_active: quote.vip_active,
      vip_valid_until: quote.vip_valid_until,
      model_tier: quote.model_tier,
      vip_discount_config_version: quote.discount_config_version,
    },
  };
}

export type BalancePrecheck =
  | { ok: true }
  | { ok: false; creditsRequired: number; creditsAvailable: number };

/**
 * 余额预检。查询失败直接抛出——原 handler 在这里返回 500，调用方沿用即可。
 *
 * 扣费额为 0（免费轮）时跳过查询：免费模型不应因为钱包不可读而无法对话。
 */
export async function checkWalletBalance(input: {
  userId: string;
  requiredAmount: number;
  walletPolicy: WalletDebitPolicy;
  openRouterModelId: string;
  log: GenerationLogger;
}): Promise<BalancePrecheck> {
  const { userId, requiredAmount, walletPolicy, openRouterModelId, log } = input;

  if (requiredAmount === 0) {
    log.biz.debug(
      { event: 'llm.balance.check_skipped', userId, model: openRouterModelId },
      'free model balance check skipped'
    );
    return { ok: true };
  }

  const wallet = await wallets().getOrCreate(userId);
  const coverage = coverageForTextWallet({
    policy: walletPolicy,
    payableCredits: requiredAmount,
    mainCredits: wallet.main_credits,
    bonusCredits: wallet.bonus_credits,
  });
  if (!coverage.ok) {
    log.biz.info(
      {
        event: 'llm.balance.insufficient',
        userId,
        policy: walletPolicy,
        code: coverage.code,
        available: coverage.available,
        required: requiredAmount,
        model: openRouterModelId,
      },
      'insufficient balance'
    );
    return {
      ok: false,
      creditsRequired: requiredAmount,
      creditsAvailable: coverage.available,
    };
  }

  return { ok: true };
}
