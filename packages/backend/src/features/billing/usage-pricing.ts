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
    modelMarkup <= 0
  ) {
    throw new Error('invalid usage deduction inputs');
  }
  return Math.round(usageCostUsd * exchangeRate * modelMarkup);
}
