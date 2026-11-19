import {
  DEFAULT_IMAGE_PLAZA_PRICING_FACTORS,
  ImagePlazaPricingFactorsSchema,
  type ImagePlazaPricingFactors,
  type VideoPlazaModelCatalog,
} from '@miniapp/shared';
import { calculateImagePlazaPrice } from './imagePlazaPricing';

export const VIDEO_PLAZA_PRICE_MAX = 1_000_000;

export function getVideoPlazaPricingFactors(catalog: VideoPlazaModelCatalog) {
  return catalog.pricing_factors ?? { ...DEFAULT_IMAGE_PLAZA_PRICING_FACTORS };
}

export function updateVideoPlazaPricingFactor(
  catalog: VideoPlazaModelCatalog,
  key: keyof ImagePlazaPricingFactors,
  value: number | null
): VideoPlazaModelCatalog | null {
  const parsed = ImagePlazaPricingFactorsSchema.safeParse({
    ...getVideoPlazaPricingFactors(catalog),
    [key]: value,
  });
  // 空参数不能写入父级，避免整份目录解析失败后丢失手工价格。
  return parsed.success ? { ...catalog, pricing_factors: parsed.data } : null;
}

export function videoPlazaPriceKey(modelId: string, matrixKey: string): string {
  return JSON.stringify([modelId, matrixKey]);
}

export function videoPlazaTierLabel(matrixKey: string): string {
  const [duration, resolution, audio] = matrixKey.split('|');
  return `${duration} 秒 / ${resolution.toUpperCase()} / ${audio === '1' ? '有声' : '无声'}`;
}

export function calculateVideoPlazaPrice(
  ...args: Parameters<typeof calculateImagePlazaPrice>
): ReturnType<typeof calculateImagePlazaPrice> {
  const price = calculateImagePlazaPrice(...args);
  return price && price.credits <= VIDEO_PLAZA_PRICE_MAX ? price : null;
}

export function recalculateVideoPlazaCatalog(catalog: VideoPlazaModelCatalog): {
  catalog: VideoPlazaModelCatalog | null;
  issues: string[];
} {
  const factors = getVideoPlazaPricingFactors(catalog);
  const issues: string[] = [];
  const models = catalog.models.map((model) => ({
    ...model,
    price_matrix: Object.fromEntries(
      Object.entries(model.price_matrix).map(([key, credits]) => {
        const price = calculateVideoPlazaPrice(
          catalog.standard_prices?.[videoPlazaPriceKey(model.id, key)],
          factors
        );
        if (!price) issues.push(`${model.name} / ${videoPlazaTierLabel(key)}`);
        return [key, price?.credits ?? credits];
      })
    ),
  }));
  // 任一档位无效都不交付部分结果，含下架模型，避免批量静默漏改。
  return {
    catalog: issues.length ? null : { ...catalog, models, pricing_factors: factors },
    issues,
  };
}
