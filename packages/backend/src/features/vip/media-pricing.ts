import { roundHalfUpToInteger } from '@miniapp/shared';

export interface VipMediaPriceQuote {
  originalCredits: number;
  payableCredits: number;
  priceLabel: string;
  discountRate: number | null;
  discountedExact: number | null;
}

/**
 * 媒体按次计费在受理时冻结报价；免费体验由调用方优先处理，不能与 VIP 折扣叠加。
 * 这里不读取配置或会员状态，保证路由预览与实际受理复用相同的确定性计算。
 */
export function quoteVipMediaPrice(input: {
  originalCredits: number;
  originalPriceLabel: string;
  vipActive: boolean;
  discountRate: number;
  isFreeTrial: boolean;
}): VipMediaPriceQuote {
  if (!Number.isInteger(input.originalCredits) || input.originalCredits <= 0) {
    throw new Error('media original credits must be a positive integer');
  }
  if (!Number.isFinite(input.discountRate) || input.discountRate <= 0 || input.discountRate > 1) {
    throw new Error('media VIP discount rate must be within (0, 1]');
  }
  if (!input.vipActive || input.isFreeTrial) {
    return {
      originalCredits: input.originalCredits,
      payableCredits: input.originalCredits,
      priceLabel: input.originalPriceLabel,
      discountRate: null,
      discountedExact: null,
    };
  }

  const discountedExact = input.originalCredits * input.discountRate;
  const payableCredits = roundHalfUpToInteger(discountedExact);
  const discountPercent = Math.round(input.discountRate * 1000) / 10;
  const discountLabel = `${Number.isInteger(discountPercent) ? discountPercent : discountPercent}折`;
  return {
    originalCredits: input.originalCredits,
    payableCredits,
    priceLabel: `VIP · ${discountLabel} · 实扣 ${payableCredits} 星尘`,
    discountRate: input.discountRate,
    discountedExact,
  };
}
