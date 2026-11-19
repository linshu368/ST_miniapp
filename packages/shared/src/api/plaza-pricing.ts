import { z } from 'zod';

const PlazaPricingInputSchema = z
  .number()
  .finite()
  .positive()
  .max(1_000_000)
  .refine((value) => Number(value.toFixed(4)) === value, '定价参数最多四位小数');

export const ImagePlazaPricingFactorsSchema = z.object({
  exchange: PlazaPricingInputSchema,
  markup: PlazaPricingInputSchema,
  ratio: PlazaPricingInputSchema,
});
export type ImagePlazaPricingFactors = z.infer<typeof ImagePlazaPricingFactorsSchema>;
export const DEFAULT_IMAGE_PLAZA_PRICING_FACTORS: Readonly<ImagePlazaPricingFactors> = {
  exchange: 7.3,
  markup: 2,
  ratio: 100,
};
