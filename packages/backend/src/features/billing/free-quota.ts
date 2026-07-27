export const CHARACTER_FREE_CHAT_QUOTA_LIMIT = 50;

export function resolveEffectiveModelMarkup(
  defaultMarkup: number,
  deductMarkup: number,
  freeQuotaGranted: boolean | null
): number {
  if (defaultMarkup > 0) return defaultMarkup;
  return freeQuotaGranted === false ? deductMarkup : 0;
}
