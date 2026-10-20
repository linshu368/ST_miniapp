import type { ImagePlazaModelCatalog } from '@miniapp/shared';

export interface ImagePlazaPricingFactors {
  exchange: number | null;
  markup: number | null;
  ratio: number | null;
}

export const IMAGE_PLAZA_PRICING_INPUT_MAX = 1_000_000;

export function imagePlazaPriceKey(modelId: string, resolutionId: string): string {
  return JSON.stringify([modelId, resolutionId]);
}

export function calculateImagePlazaPrice(
  usd: number | null | undefined,
  factors: ImagePlazaPricingFactors
): { raw: number; credits: number } | null {
  const values = [usd, factors.exchange, factors.markup, factors.ratio];
  if (
    !values.every(
      (value): value is number =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value > 0 &&
        value <= IMAGE_PLAZA_PRICING_INPUT_MAX &&
        Number(value.toFixed(4)) === value
    )
  ) {
    return null;
  }
  // 输入最多四位小数；整数运算避免 0.07 × 100 等浮点误差把整十价格多进一档。
  const numerator = values.reduce(
    (product, value) => product * BigInt(Math.round(value * 10_000)),
    1n
  );
  const scale = 10_000n ** 4n;
  const step = scale * 10n;
  const rounded = ((numerator + step - 1n) / step) * 10n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { raw: Number(numerator) / Number(scale), credits: Number(rounded) };
}

export function recalculateImagePlazaCatalog(
  catalog: ImagePlazaModelCatalog,
  standardPrices: Readonly<Record<string, number | null>>,
  factors: ImagePlazaPricingFactors
): { catalog: ImagePlazaModelCatalog | null; issues: string[] } {
  const issues: string[] = [];
  const models = catalog.models.map((model) => ({
    ...model,
    resolutions: model.resolutions.map((tier) => {
      const price = calculateImagePlazaPrice(
        standardPrices[imagePlazaPriceKey(model.id, tier.id)],
        factors
      );
      if (!price) {
        issues.push(`${model.name} / ${tier.label} (${tier.id})`);
        return tier;
      }
      return { ...tier, credits: price.credits };
    }),
  }));
  // 先计算完整结果；任一档位失败都不交付部分价格，避免批量操作静默漏改。
  return { catalog: issues.length ? null : { ...catalog, models }, issues };
}
