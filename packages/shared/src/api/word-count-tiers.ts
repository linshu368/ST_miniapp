import { z } from 'zod';

/** 用户偏好与档位表匹配用的稳定 id（写入 miniapp_user_settings.pref_word_count） */
export const WordCountTierIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/,
    'tier id must start with a letter or number; then letters, numbers, dots, underscores, plus or hyphens'
  );

export const WordCountLayoutColumnsSchema = z.union([z.literal(2), z.literal(3), z.literal(4)]);

export const WordCountTierSchema = z.object({
  id: WordCountTierIdSchema,
  /** MiniApp「回复长度」按钮文案 */
  ui_label: z.string().trim().min(1).max(20),
  /** 注入 {{WORD_COUNT}} 的文案 */
  prompt_value: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  sort_order: z.number().int().nonnegative(),
});

export const WordCountTiersConfigSchema = z
  .object({
    tiers: z.array(WordCountTierSchema).min(1),
    default_tier_id: WordCountTierIdSchema,
    layout: z
      .object({
        columns: WordCountLayoutColumnsSchema,
      })
      .default({ columns: 4 }),
  })
  .superRefine((value, ctx) => {
    const ids = value.tiers.map((tier) => tier.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'word count tier ids must be unique',
        path: ['tiers'],
      });
    }
    const defaultTier = value.tiers.find((tier) => tier.id === value.default_tier_id);
    if (!defaultTier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'default_tier_id must match a tier id',
        path: ['default_tier_id'],
      });
    } else if (!defaultTier.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'default_tier_id must reference an enabled tier',
        path: ['default_tier_id'],
      });
    }
  });

/** Admin 编辑中允许暂时不完整的草稿 */
export const EditableWordCountTiersConfigSchema = z.object({
  tiers: z.array(
    z.object({
      id: z.string(),
      ui_label: z.string(),
      prompt_value: z.string(),
      enabled: z.boolean(),
      sort_order: z.number().int().nonnegative(),
    })
  ),
  default_tier_id: z.string(),
  layout: z.object({
    columns: z.union([z.literal(2), z.literal(3), z.literal(4), z.number()]),
  }),
});

/** 下发给 MiniApp 的公开档位（仅 enabled） */
export const PublicWordCountTiersSchema = z.object({
  tiers: z.array(
    z.object({
      id: WordCountTierIdSchema,
      ui_label: z.string().trim().min(1).max(20),
      sort_order: z.number().int().nonnegative(),
    })
  ),
  default_tier_id: WordCountTierIdSchema,
  layout: z.object({
    columns: WordCountLayoutColumnsSchema,
  }),
});

export type WordCountTier = z.infer<typeof WordCountTierSchema>;
export type WordCountTiersConfig = z.infer<typeof WordCountTiersConfigSchema>;
export type EditableWordCountTiersConfig = z.infer<typeof EditableWordCountTiersConfigSchema>;
export type PublicWordCountTiers = z.infer<typeof PublicWordCountTiersSchema>;

export const DEFAULT_WORD_COUNT_TIERS_CONFIG: WordCountTiersConfig = {
  tiers: [
    {
      id: '100-300',
      ui_label: '简短',
      prompt_value: '100-300',
      enabled: true,
      sort_order: 0,
    },
    {
      id: '300-500',
      ui_label: '适中',
      prompt_value: '300-500',
      enabled: true,
      sort_order: 1,
    },
    {
      id: '500-800',
      ui_label: '详细',
      prompt_value: '500-800',
      enabled: true,
      sort_order: 2,
    },
    {
      id: '800+',
      ui_label: '长篇',
      prompt_value: '800以上',
      enabled: true,
      sort_order: 3,
    },
  ],
  default_tier_id: '300-500',
  layout: { columns: 4 },
};

export function toPublicWordCountTiers(config: WordCountTiersConfig): PublicWordCountTiers {
  const tiers = config.tiers
    .filter((tier) => tier.enabled)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((tier) => ({
      id: tier.id,
      ui_label: tier.ui_label,
      sort_order: tier.sort_order,
    }));

  const defaultEnabled = tiers.some((tier) => tier.id === config.default_tier_id);
  return {
    tiers,
    default_tier_id: defaultEnabled
      ? config.default_tier_id
      : (tiers[0]?.id ?? config.default_tier_id),
    layout: { columns: config.layout.columns },
  };
}
