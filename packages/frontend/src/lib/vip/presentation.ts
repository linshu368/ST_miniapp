import type { NotificationItem, PaymentOrder, PublicModelCatalogTier } from '@miniapp/shared';

import { formatNumber, formatYuanShort } from '@/lib/utils/payment';

/**
 * 折扣文案只格式化服务端已经给出的比率。
 * 不在这里把默认 0.95 或原型 0.88 当成当前配置。
 */
export function formatDiscountLabel(rate: number): string | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return null;
  const percent = Math.round(rate * 1000) / 10;
  return `${Number.isInteger(percent) ? String(percent) : String(percent)}折`;
}

export function publishedDiscountRate(
  tiers: Array<Pick<PublicModelCatalogTier, 'discount_rate'>> | undefined
): number | null {
  if (!tiers) return null;
  for (const tier of tiers) {
    const rate = tier.discount_rate;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 1) return rate;
  }
  return null;
}

export function shouldShowVipEntryBadge(input: {
  statusKnown: boolean;
  active: boolean;
  entryBadgeVisible: boolean;
  discountLabel: string | null;
}): boolean {
  return (
    input.statusKnown && !input.active && input.entryBadgeVisible && input.discountLabel !== null
  );
}

export function vipEntryLabel(status: { active: boolean; remaining_days: number } | null): string {
  if (!status?.active) return 'VIP';
  return `VIP · 剩 ${status.remaining_days} 天`;
}

export function vipMembershipSummary(status: {
  active: boolean;
  remaining_days: number;
  last_plan_id: string | null;
}): { title: string; detail: string } {
  if (status.active) {
    return { title: 'VIP 会员', detail: `剩余 ${status.remaining_days} 天` };
  }
  if (status.last_plan_id) {
    return { title: '会员已到期', detail: '续费后有效期会在新订单上顺延' };
  }
  return { title: '尚未开通', detail: '开通后解锁标准、旗舰模型和高级图片资格' };
}

export interface TierQuoteView {
  summary: string;
  originalLabel: string;
  payableLabel: string;
}

export function formatTierVipNote(
  tier: Pick<
    PublicModelCatalogTier,
    'key' | 'discount_rate' | 'discounted_exact' | 'payable_credits'
  >
): string | null {
  const rateLabel =
    typeof tier.discount_rate === 'number' ? formatDiscountLabel(tier.discount_rate) : null;
  const exact =
    typeof tier.discounted_exact === 'number' ? formatServerNumber(tier.discounted_exact) : null;
  const payable =
    typeof tier.payable_credits === 'number' ? formatServerNumber(tier.payable_credits) : null;
  if (!rateLabel || !exact || !payable) return null;

  const price = exact === payable ? `${payable} 星尘/轮` : `${exact}，实扣 ${payable} 星尘/轮`;
  const paidNote = `VIP ${rateLabel} → ${price}`;
  return tier.key === 'light'
    ? `免费优先，免费轮次不叠加 ${rateLabel}；付费轮次 ${paidNote}`
    : paidNote;
}

/** 只拼接目录里已经算好的原价、折扣、计算值和实扣，不自己乘折扣。 */
export function formatTierQuote(
  tier: Pick<
    PublicModelCatalogTier,
    'original_credits' | 'discount_rate' | 'discounted_exact' | 'payable_credits'
  >
): TierQuoteView | null {
  const payable = tier.payable_credits;
  const original = tier.original_credits;
  if (typeof payable !== 'number' || !Number.isFinite(payable)) return null;
  const payableLabel = `${formatServerNumber(payable) ?? String(payable)} 星尘/轮`;
  const originalLabel =
    typeof original === 'number' && Number.isFinite(original)
      ? `${formatServerNumber(original) ?? String(original)} 星尘`
      : payableLabel;
  const rateLabel =
    typeof tier.discount_rate === 'number' ? formatDiscountLabel(tier.discount_rate) : null;
  const exact =
    typeof tier.discounted_exact === 'number' ? formatServerNumber(tier.discounted_exact) : null;
  if (rateLabel && exact && typeof original === 'number') {
    return {
      originalLabel,
      payableLabel,
      summary: `原价 ${originalLabel} × ${rateLabel} = ${exact}，实扣 ${payableLabel}`,
    };
  }
  return {
    originalLabel,
    payableLabel,
    summary: `当前价格 ${payableLabel}`,
  };
}

export function formatServerNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function selectionKey(kind: 'credits' | 'vip', id: string): string {
  return `${kind}:${id}`;
}

export interface CheckoutSelection {
  kind: 'credits' | 'vip';
  id: string;
  priceCents: number;
  available: boolean;
}

export function resolveCheckoutSelection(input: {
  selectedKey: string | null;
  creditPlans: Array<{ id: string; price_cents: number }>;
  vipPlans: Array<{ id: string; price_cents: number; available: boolean }>;
}): CheckoutSelection | null {
  if (!input.selectedKey) return null;
  const credits = input.creditPlans.find(
    (plan) => selectionKey('credits', plan.id) === input.selectedKey
  );
  if (credits) {
    return {
      kind: 'credits',
      id: credits.id,
      priceCents: credits.price_cents,
      available: true,
    };
  }
  const vip = input.vipPlans.find((plan) => selectionKey('vip', plan.id) === input.selectedKey);
  if (!vip) return null;
  return {
    kind: 'vip',
    id: vip.id,
    priceCents: vip.price_cents,
    available: vip.available,
  };
}

export function checkoutButtonLabel(input: {
  pending: boolean;
  selection: CheckoutSelection | null;
  vipActive: boolean;
  creditsButtonText: string;
  vipVerb?: 'short' | 'immediate';
}): string {
  if (input.pending) return '创建中...';
  if (!input.selection) return '请选择套餐';
  if (input.selection.kind === 'vip' && !input.selection.available) return 'VIP 购买暂未开放';
  const price = formatYuanShort(input.selection.priceCents);
  if (input.selection.kind === 'vip') {
    const immediate = input.vipVerb === 'immediate';
    const verb = input.vipActive
      ? immediate
        ? '立即续费'
        : '续费'
      : immediate
        ? '立即开通'
        : '开通';
    return `${verb} ¥${price}`;
  }
  return `${input.creditsButtonText} ¥${price}`;
}

export function checkinRewardLines(checkin: {
  reward_credits: number;
  base_reward_credits?: number;
  vip_reward_credits?: number;
}): string[] {
  const base = checkin.base_reward_credits;
  const extra = checkin.vip_reward_credits;
  if (typeof base === 'number' && typeof extra === 'number' && extra > 0) {
    return [`基础签到 +${formatNumber(base)} 星尘`, `VIP 加成 +${formatNumber(extra)} 星尘`];
  }
  return [`星尘 +${formatNumber(checkin.reward_credits)} 已到账。`];
}

export function modelSwitchFeedback(duringGeneration: boolean): string {
  return duringGeneration ? '模型已切换，下一条回复生效' : '模型已切换';
}

export type BillingFailureAction =
  | { type: 'vip' }
  | { type: 'recharge' }
  | { type: 'main_wallet' }
  | { type: 'unavailable' }
  | { type: 'unknown' };

const VIP_CODES = new Set(['VIP_REQUIRED', 'image_vip_required']);
const RECHARGE_CODES = new Set([
  'insufficient_balance',
  'INSUFFICIENT_CREDITS',
  'TOTAL_CREDITS_INSUFFICIENT',
  'image_insufficient_balance',
]);
const MAIN_WALLET_CODES = new Set(['MAIN_CREDITS_INSUFFICIENT', 'image_main_credits_insufficient']);
const UNAVAILABLE_CODES = new Set([
  'ADVANCED_IMAGE_UNAVAILABLE',
  'IMAGE_ADVANCED_UNAVAILABLE',
  'image_advanced_unavailable',
]);

export function billingFailureAction(code: string | undefined): BillingFailureAction {
  if (!code) return { type: 'unknown' };
  if (VIP_CODES.has(code)) return { type: 'vip' };
  if (MAIN_WALLET_CODES.has(code)) return { type: 'main_wallet' };
  if (RECHARGE_CODES.has(code)) return { type: 'recharge' };
  if (UNAVAILABLE_CODES.has(code)) return { type: 'unavailable' };
  return { type: 'unknown' };
}

export const MAIN_WALLET_NOTICE = '这个功能只能使用充值星尘，专项星尘不能抵扣。';

export function supportsVipRenewal(item: Pick<NotificationItem, 'kind' | 'action_path'>): boolean {
  return item.kind === 'vip_expiry' || item.action_path === '/vip';
}

export function isVipOrder(order: Pick<PaymentOrder, 'product_type'>): boolean {
  return order.product_type === 'vip';
}

export function orderBenefitLabel(
  order: Pick<
    PaymentOrder,
    'product_type' | 'credits_amount' | 'bonus_credits' | 'vip_duration_days' | 'vip_bonus_credits'
  >
): string {
  if (isVipOrder(order)) {
    const duration =
      typeof order.vip_duration_days === 'number'
        ? `${order.vip_duration_days} 天会员`
        : 'VIP 会员';
    const bonus = order.vip_bonus_credits ?? 0;
    return bonus > 0 ? `${duration} · 赠送 ${formatNumber(bonus)} 专项星尘` : duration;
  }
  return `${formatNumber(order.credits_amount + order.bonus_credits)} 星尘`;
}

export type AdvancedImageEntry = 'hidden' | 'open' | 'vip_locked';

export function advancedImageEntry(
  tier:
    | {
        enabled: boolean;
        available: boolean;
        locked_reason: string | null;
      }
    | null
    | undefined
): AdvancedImageEntry {
  if (!tier?.enabled) return 'hidden';
  if (tier.locked_reason === 'ADVANCED_IMAGE_UNAVAILABLE') return 'hidden';
  if (!tier.available && tier.locked_reason === 'VIP_REQUIRED') return 'vip_locked';
  if (!tier.available) return 'hidden';
  return 'open';
}
