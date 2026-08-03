import type { FixedDeductionConfig } from '@miniapp/shared';

export function calculateUsageDeduction(
  usageCostUsd: number,
  exchangeRate: number,
  modelMarkup: number
): number {
  if (
    !Number.isFinite(usageCostUsd) ||
    usageCostUsd < 0 ||
    !Number.isFinite(exchangeRate) ||
    exchangeRate <= 0 ||
    !Number.isFinite(modelMarkup) ||
    modelMarkup < 0
  ) {
    throw new Error('invalid usage deduction inputs');
  }
  if (modelMarkup === 0) return 0;
  return Math.round(usageCostUsd * exchangeRate * modelMarkup * 10) / 10;
}

export type FixedDeductionCategory =
  | 'free_quota'
  | 'free_quota_exhausted'
  | 'light'
  | 'standard'
  | 'premium'
  | 'standard_fallback';

export interface FixedDeductionDecision {
  amount: number;
  category: FixedDeductionCategory;
}

export function resolveFixedDeduction(input: {
  defaultModelMarkup: number;
  effectiveModelMarkup: number;
  modelTier: 'light' | 'standard' | 'premium' | null;
  config: FixedDeductionConfig;
}): FixedDeductionDecision {
  const amounts = Object.values(input.config);
  if (
    !Number.isFinite(input.defaultModelMarkup) ||
    input.defaultModelMarkup < 0 ||
    !Number.isFinite(input.effectiveModelMarkup) ||
    input.effectiveModelMarkup < 0 ||
    amounts.some((amount) => !Number.isFinite(amount) || amount < 0)
  ) {
    throw new Error('invalid fixed deduction inputs');
  }

  if (input.defaultModelMarkup === 0) {
    return input.effectiveModelMarkup === 0
      ? { amount: 0, category: 'free_quota' }
      : {
          amount: input.config.freeQuotaExhausted,
          category: 'free_quota_exhausted',
        };
  }

  if (input.modelTier === 'premium') {
    return { amount: input.config.premium, category: 'premium' };
  }
  if (input.modelTier === 'standard') {
    return { amount: input.config.standard, category: 'standard' };
  }
  if (input.modelTier === 'light') {
    return { amount: input.config.light, category: 'light' };
  }
  return { amount: input.config.standard, category: 'standard_fallback' };
}

export function getInitialBillingDecision(input: {
  usageCost: unknown;
  exchangeRate: number;
  modelMarkup: number;
  fixedDeduction?: number;
}): { amount: number; hasActualUsage: boolean; pending: boolean } {
  const hasActualUsage = typeof input.usageCost === 'number' && Number.isFinite(input.usageCost);
  if (input.fixedDeduction !== undefined) {
    if (!Number.isFinite(input.fixedDeduction) || input.fixedDeduction < 0) {
      throw new Error('invalid fixed deduction');
    }
    return {
      amount: Math.round(input.fixedDeduction * 10) / 10,
      hasActualUsage,
      pending: false,
    };
  }
  if (input.modelMarkup === 0) {
    return { amount: 0, hasActualUsage, pending: false };
  }
  if (!hasActualUsage) {
    return { amount: 0, hasActualUsage: false, pending: true };
  }
  return {
    amount: calculateUsageDeduction(
      input.usageCost as number,
      input.exchangeRate,
      input.modelMarkup
    ),
    hasActualUsage: true,
    pending: false,
  };
}

export function shouldRecordUsageCharge(status: string, modelMarkup: number): boolean {
  return status === 'success' || modelMarkup === 0;
}

export function calculateFallbackDeduction(fallbackCost: number, modelMarkup: number): number {
  if (
    !Number.isFinite(fallbackCost) ||
    fallbackCost < 0 ||
    !Number.isFinite(modelMarkup) ||
    modelMarkup < 0
  ) {
    throw new Error('invalid fallback deduction inputs');
  }
  return modelMarkup === 0 ? 0 : Math.round(fallbackCost * 10) / 10;
}
