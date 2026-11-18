import { z } from 'zod';

export const IMAGE_PLAZA_INVALID_CURSOR = 'IMAGE_PLAZA_INVALID_CURSOR';
const id = z.string().uuid();
const filter = z.string().regex(/^[a-f0-9]{64}$/);
const orderPattern = /^[1-9][0-9]{0,18}$/;
const order = z
  .string()
  .regex(orderPattern)
  .refine((value) => orderPattern.test(value) && BigInt(value) <= 9223372036854775807n)
  .nullable();
const likeCount = z.number().int().positive().max(2147483647);
const legacyBase = z.object({
  v: z.literal(1),
  filter,
  id,
  publishedAt: z.string().datetime({ offset: true }),
});
// Kept parseable for old consumers; the new recommended reader explicitly rejects v1.
const legacy = z.discriminatedUnion('partition', [
  legacyBase.extend({ sort: z.literal('latest'), partition: z.literal('latest') }),
  legacyBase.extend({ sort: z.literal('recommended'), partition: z.literal('liked'), likeCount }),
  legacyBase.extend({ sort: z.literal('recommended'), partition: z.literal('zero'), order }),
]);
const recommendedBase = z.object({
  v: z.literal(2),
  filter,
  id,
  sort: z.literal('recommended'),
  rankingRevision: id,
});
export const ImagePlazaRecommendedCursorSchema = z.discriminatedUnion('partition', [
  recommendedBase.extend({ partition: z.literal('liked'), likeCount }),
  recommendedBase.extend({ partition: z.literal('zero'), order }),
]);
export type ImagePlazaRecommendedCursor = z.infer<typeof ImagePlazaRecommendedCursorSchema>;
export const ImagePlazaFeedCursorSchema = z.union([legacy, ImagePlazaRecommendedCursorSchema]);
export type ImagePlazaFeedCursor = z.infer<typeof ImagePlazaFeedCursorSchema>;
