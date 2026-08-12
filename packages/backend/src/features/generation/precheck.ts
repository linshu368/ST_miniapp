/**
 * backend / features / generation / precheck.ts
 *
 * 定档扣费额与余额预检（M3a）。搬自 routes/llm-proxy.ts 原第 446~527 行，
 * 分支、日志事件名与字段逐条对照原 handler，行为零变化。
 *
 * 预检在调用上游之前完成：余额不足要在首字节写出前判定，这样调用方还能用
 * HTTP 状态码（ST 链路 402）而不是流内 error 事件收口。
 */

import { resolveFixedDeduction, type FixedDeductionDecision } from '../billing/usage-pricing.js';
import type { FixedDeductionCategory } from '../billing/usage-pricing.js';
import type { LlmPricingConfig, ModelBillingContext } from '../../platform/model-tiers.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import type { GenerationLogger } from './types.js';

let walletRepository: MiniappWalletRepository | null = null;

function wallets(): MiniappWalletRepository {
  return (walletRepository ??= new MiniappWalletRepository());
}

/** 落 chat_history 与 charge 的计费快照，字段名与 ChatHistoryEntry 对齐，可直接展开。 */
export interface BillingSnapshot {
  charge_id: string;
  model_id: string | null;
  model_display_name: string;
  model_markup: number;
  fixed_deduction: number;
  fixed_deduction_category: FixedDeductionCategory;
  catalog_version: number;
  pricing_config_version: number;
  exchange_rate: number;
  fallback_cost: number;
}

export interface BillingPlan {
  chargeId: string;
  fixedDeduction: FixedDeductionDecision;
  snapshot: BillingSnapshot;
}

/**
 * 结算本轮的定档扣费额并固化计费快照。
 *
 * effectiveModelMarkup 来自免费额度预留结果，不是模型的默认倍率——免费轮为 0，
 * 额度耗尽后为 deduct_markup。
 */
export function resolveBillingPlan(input: {
  chargeId: string;
  billing: ModelBillingContext;
  effectiveModelMarkup: number;
  pricing: LlmPricingConfig;
  log: GenerationLogger;
}): BillingPlan {
  const { chargeId, billing, effectiveModelMarkup, pricing, log } = input;

  const fixedDeduction = resolveFixedDeduction({
    defaultModelMarkup: billing.modelMarkup,
    effectiveModelMarkup,
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

  return {
    chargeId,
    fixedDeduction,
    snapshot: {
      charge_id: chargeId,
      model_id: billing.modelId,
      model_display_name: billing.modelDisplayName,
      model_markup: effectiveModelMarkup,
      fixed_deduction: fixedDeduction.amount,
      fixed_deduction_category: fixedDeduction.category,
      catalog_version: billing.catalogVersion,
      pricing_config_version: pricing.version,
      exchange_rate: pricing.exchangeRate,
      fallback_cost: pricing.fallbackCost,
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
  openRouterModelId: string;
  log: GenerationLogger;
}): Promise<BalancePrecheck> {
  const { userId, requiredAmount, openRouterModelId, log } = input;

  if (requiredAmount === 0) {
    log.biz.debug(
      { event: 'llm.balance.check_skipped', userId, model: openRouterModelId },
      'free model balance check skipped'
    );
    return { ok: true };
  }

  const wallet = await wallets().getOrCreate(userId);
  const balance = wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
  if (balance < requiredAmount) {
    log.biz.info(
      {
        event: 'llm.balance.insufficient',
        userId,
        balance,
        required: requiredAmount,
        model: openRouterModelId,
      },
      'insufficient balance'
    );
    return { ok: false, creditsRequired: requiredAmount, creditsAvailable: balance };
  }

  return { ok: true };
}
