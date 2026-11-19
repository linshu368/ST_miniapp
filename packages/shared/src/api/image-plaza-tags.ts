import { z } from 'zod';

export const IMAGE_PLAZA_DEFAULT_TAG_GROUP_ID = 'style';
export const IMAGE_PLAZA_DEFAULT_TAG_GROUP_LABEL = '风格';
export const ImagePlazaTagGroupLayoutSchema = z.enum(['chips', 'grid']);
export type ImagePlazaTagGroupLayout = z.infer<typeof ImagePlazaTagGroupLayoutSchema>;

const ImagePlazaTagConfigItemSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
  enabled: z.boolean(),
  sort_order: z.number().int().nonnegative(),
  group_id: z.string().trim().min(1).max(40).default(IMAGE_PLAZA_DEFAULT_TAG_GROUP_ID),
  group_label: z.string().trim().min(1).max(40).default(IMAGE_PLAZA_DEFAULT_TAG_GROUP_LABEL),
  group_sort_order: z.number().int().nonnegative().default(0),
  group_layout: ImagePlazaTagGroupLayoutSchema.default('chips'),
});

export const ImagePlazaTagConfigSchema = z
  .array(ImagePlazaTagConfigItemSchema)
  .max(80)
  .superRefine((tags, ctx) => {
    const ids = new Set<string>();
    const groups = new Map<
      string,
      { label: string; sortOrder: number; layout: ImagePlazaTagGroupLayout }
    >();
    for (const [index, tag] of tags.entries()) {
      if (tag.id === 'all') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: 'all 为系统保留 ID',
        });
      }
      if (tag.group_id === 'all') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'group_id'],
          message: 'all 为系统保留分组 ID',
        });
      }
      if (ids.has(tag.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: '标签 ID 重复' });
      }
      ids.add(tag.id);

      const previous = groups.get(tag.group_id);
      const current = {
        label: tag.group_label,
        sortOrder: tag.group_sort_order,
        layout: tag.group_layout,
      };
      if (
        previous &&
        (previous.label !== current.label ||
          previous.sortOrder !== current.sortOrder ||
          previous.layout !== current.layout)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'group_id'],
          message: `同一分组 ID 的名称、顺序和布局必须一致：${tag.group_id}`,
        });
      } else {
        groups.set(tag.group_id, current);
      }
    }
  });
export type ImagePlazaTagConfig = z.infer<typeof ImagePlazaTagConfigSchema>;
