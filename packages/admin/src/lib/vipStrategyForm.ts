import {
  formatCentsAsYuan,
  VipCheckinBonusConfigSchema,
  type VipCheckinBonusConfig,
  type VipPlanTerms,
} from '@miniapp/shared';

/** 页面只展示元，保存和发布仍使用整数分。 */
export function vipPriceLabel(priceCents: number): string {
  return `${formatCentsAsYuan(priceCents)} 元`;
}

export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function checkinAbsoluteCredits(credits: number): VipCheckinBonusConfig {
  return VipCheckinBonusConfigSchema.parse(credits);
}

export function withPlanPatch(plan: VipPlanTerms, patch: Partial<VipPlanTerms>): VipPlanTerms {
  return { ...plan, ...patch };
}
