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

export function getInitialBillingDecision(input: {
  usageCost: unknown;
  exchangeRate: number;
  modelMarkup: number;
}): { amount: number; hasActualUsage: boolean; pending: boolean } {
  const hasActualUsage = typeof input.usageCost === 'number' && Number.isFinite(input.usageCost);
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
