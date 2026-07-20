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
