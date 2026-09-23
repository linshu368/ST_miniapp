import type { MediaBillingPreview } from '@miniapp/shared';

/**
 * 免费次数文案只展示接口里的已发布上限。
 * 上限缺失时不补一个写死的次数，避免把默认 3 当成当前配置。
 */
export function formatFreeTrialBillingLabel(
  ordinal: number | null | undefined,
  limit: number | null | undefined
): string {
  const noCharge = '本次不消耗星尘';
  if (typeof limit !== 'number' || !Number.isInteger(limit)) return `免费体验 · ${noCharge}`;
  const shownOrdinal = typeof ordinal === 'number' && Number.isInteger(ordinal) ? ordinal : 1;
  return `免费体验 第 ${shownOrdinal}/${limit} 次 · ${noCharge}`;
}

/** 报价刷新或失败时不沿用缓存里的免费承诺；次数只来自服务端。 */
export function formatMediaBillingPreview(
  billing: MediaBillingPreview | undefined,
  refreshing: boolean,
  failed: boolean,
  allowFreeTrial = true
): string {
  if (refreshing) return '正在更新费用…';
  if (failed || !billing) return '费用暂不可用，请稍后重试';
  if (allowFreeTrial && billing.billing_mode === 'free_trial') {
    return formatFreeTrialBillingLabel(billing.free_trial_ordinal, billing.free_trial_limit);
  }
  return billing.billing_mode === 'paid'
    ? `${billing.price_label} · 从充值星尘扣除`
    : billing.price_label;
}
