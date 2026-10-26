import { z } from 'zod';

export const MAX_REPLY_STYLE_OPTIONS = 24;
export const MAX_REPLY_STYLE_PREFERENCES = 64;
/** Stable UI identity; the operator-defined marker is a separate editable value. */
export const ReplyStyleOptionIdSchema = z.string().regex(/^style-[a-z0-9][a-z0-9-]{0,58}$/);

export const ReplyStyleOptionSchema = z
  .object({
    id: ReplyStyleOptionIdSchema,
    name: z.string().trim().min(1, '请填写选项名称').max(40),
    description: z.string().trim().max(200),
    marker: z.string().trim().max(120),
    rules: z.string().trim().max(12000),
    enabled: z.boolean(),
  })
  .strict();

export const ReplyStyleOptionsConfigSchema = z
  .object({
    options: z.array(ReplyStyleOptionSchema).max(MAX_REPLY_STYLE_OPTIONS),
  })
  .strict()
  .superRefine(({ options }, ctx) => {
    const ids = new Set<string>();
    const markers = new Set<string>();
    options.forEach((option, index) => {
      if (ids.has(option.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', index, 'id'],
          message: '选项标识不能重复',
        });
      ids.add(option.id);
      if (option.marker && markers.has(option.marker))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', index, 'marker'],
          message: '英文占位符不能重复',
        });
      if (option.marker) markers.add(option.marker);
    });
  });
export type ReplyStyleOption = z.infer<typeof ReplyStyleOptionSchema>;
export type ReplyStyleOptionsConfig = z.infer<typeof ReplyStyleOptionsConfigSchema>;

/** Public UI metadata; private markers and rule content are deliberately absent. */
export const PublicReplyStyleOptionSchema = z
  .object({
    id: ReplyStyleOptionIdSchema,
    name: z.string().min(1).max(40),
    description: z.string().max(200),
  })
  .strict();
export type PublicReplyStyleOption = z.infer<typeof PublicReplyStyleOptionSchema>;

/** A PATCH is a partial assignment, never a replacement of the stored map. */
export const ReplyStylePreferencesSchema = z
  .record(ReplyStyleOptionIdSchema, z.boolean())
  .refine(
    (value) => Object.keys(value).length <= MAX_REPLY_STYLE_PREFERENCES,
    '回复风格偏好数量超出上限'
  );
export type ReplyStylePreferences = z.infer<typeof ReplyStylePreferencesSchema>;
