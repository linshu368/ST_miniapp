export const CHARACTER_FREE_CHAT_QUOTA_LIMIT = 50;

// 与 st-extension 注入端的提取正则同宽度：只要能安全转成 UUID 并参与外键即可，
// 不做版本/变体校验。
const CHARACTER_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isQuotaTrackableCharacterId(value: string | null | undefined): value is string {
  return typeof value === 'string' && CHARACTER_ID_PATTERN.test(value);
}

export function resolveEffectiveModelMarkup(
  defaultMarkup: number,
  deductMarkup: number,
  freeQuotaGranted: boolean | null
): number {
  if (defaultMarkup > 0) return defaultMarkup;
  return freeQuotaGranted === false ? deductMarkup : 0;
}
