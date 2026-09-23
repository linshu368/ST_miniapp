/**
 * 免费次数文案只展示接口里的已发布上限。
 * 上限缺失时不补一个写死的次数，避免把默认 3 当成当前配置。
 */
export function formatFreeTrialBillingLabel(
  ordinal: number | null | undefined,
  limit: number | null | undefined
): string {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) return '免费体验';
  const shownOrdinal = typeof ordinal === 'number' && Number.isInteger(ordinal) ? ordinal : 1;
  return `免费体验 ${shownOrdinal}/${limit}`;
}
