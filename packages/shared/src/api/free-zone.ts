import { z } from 'zod';
import { ModelCatalogTierKeySchema } from './model-tier-key.js';

/**
 * 畅聊栏目（免费模型）：运营配置与公开契约。
 *
 * 模型全部来自 Surplus 低价池，由后台评估任务按「官方数据初筛 + 在架业务数据」自动上下架；
 * 运营只维护候选池和门槛。门槛字段为 null 表示这一项不检查。
 */
export const FREE_ZONE_CONFIG_KEY = 'free_zone_config';

/** 免费模型 id 统一带这个前缀，和付费目录的 id 在任何地方都不会撞。 */
export const FREE_ZONE_MODEL_ID_PREFIX = 'free-';

export function isFreeZoneModelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(FREE_ZONE_MODEL_ID_PREFIX);
}

const PercentSchema = z.number().min(0).max(100);
const DurationMsSchema = z.number().int().positive().max(110_000);
const IsoTimeSchema = z.string().datetime({ offset: true });

export const FreeZoneCandidateSchema = z.object({
  id: z
    .string()
    .trim()
    .max(64)
    .regex(/^free-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, '免费模型 id 必须以 free- 开头'),
  /** Surplus 的标准模型名，例如 deepseek-v4-pro */
  surplus_model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  display_name: z.string().trim().min(1).max(40),
  /** 一句话介绍，可以留空（留空时栏目里不显示这一行） */
  tagline: z.string().trim().max(40).default(''),
  /** 系列：下架时优先换同系列，例如 deepseek、gemini */
  family: z.string().trim().min(1).max(40),
  /** 对标档位：划线原价取这一档当前的星尘价 */
  benchmark_tier: ModelCatalogTierKeySchema,
});

export const FreeZoneScreeningSchema = z.object({
  /** 折扣底线，同时作为请求时的 X-Min-Discount */
  min_discount_pct: z.number().int().min(1).max(100).default(85),
  min_qualified_offers: z.number().int().min(1).max(10_000).nullable().default(5),
  min_realized_discount_pct: PercentSchema.nullable().default(85),
  min_uptime_pct: PercentSchema.nullable().default(95),
  max_ttft_p50_ms: DurationMsSchema.nullable().default(3000),
  max_ttft_p90_ms: DurationMsSchema.nullable().default(7500),
  min_tps: z.number().positive().max(100_000).nullable().default(30),
  /** 供应商近 24 小时缓存命中率下限（Surplus 统计的是这家所有买家的命中率）；命中低，同样的对话实际花费更高 */
  min_cache_hit_rate_pct: PercentSchema.nullable().default(70),
  min_samples: z.number().int().nonnegative().nullable().default(200),
  /**
   * 选供应商时的价格分档倍数：和最便宜的达标供应商价格差不到这个倍数的算同一档、比首字；
   * 更贵的档只有便宜档没人时才考虑。
   */
  price_band_ratio: z.number().min(1).max(100).default(3),
  /**
   * 派单探测：评估时对在架、准备上架的模型，用选定的供应商带折扣底线真发一个只要几个字的请求。
   * 派不出去（折扣底线达不到、没有可用卖家）就当这家不达标——订单簿上的折扣和 Surplus
   * 派单时估算的折扣可能不一样。
   */
  probe_enabled: z.boolean().default(true),
  /** 探测首字上限；留空只记录不检查 */
  max_probe_ttft_ms: DurationMsSchema.nullable().default(null),
});

export const FreeZoneOnShelfSchema = z.object({
  window_hours: z.number().int().min(1).max(168).default(24),
  min_turns: z.number().int().min(1).max(100_000).default(50),
  max_no_output_pct: PercentSchema.nullable().default(10),
  max_fallback_delivered_pct: PercentSchema.nullable().default(15),
  max_timeout_pct: PercentSchema.nullable().default(2),
  max_ttft_p90_ms: DurationMsSchema.nullable().default(7500),
  max_refusal_pct: PercentSchema.nullable().default(null),
  max_truncation_pct: PercentSchema.nullable().default(null),
  max_dislike_pct: PercentSchema.nullable().default(null),
});

export const FreeZoneRelistSchema = z.object({
  required_passes: z.number().int().min(1).max(48).default(2),
  cooldown_official_minutes: z.number().int().min(0).max(43_200).default(120),
  /** 业务原因下架的冷却梯度：7 天内第 1、2、3… 次下架依次取值，超出取最后一个 */
  cooldown_business_minutes: z
    .array(z.number().int().min(0).max(43_200))
    .min(1)
    .max(5)
    .default([1440, 4320, 10080]),
});

export const FreeZoneFirstTokenSchema = z
  .object({
    /** 主模型等多久还没出字就启动兜底 */
    primary_wait_ms: DurationMsSchema.default(4000),
    /** 首字总上限 */
    deadline_ms: DurationMsSchema.default(7500),
  })
  .refine((value) => value.primary_wait_ms < value.deadline_ms, {
    message: '启动兜底的等待时间必须短于首字总上限',
    path: ['primary_wait_ms'],
  });

export const FreeZonePeriodSchema = z
  .object({ starts_at: IsoTimeSchema, ends_at: IsoTimeSchema })
  .refine((value) => Date.parse(value.starts_at) < Date.parse(value.ends_at), {
    message: '福利期结束时间必须晚于开始时间',
    path: ['ends_at'],
  });

export const FreeZoneScopeSchema = z.enum(['all_cards', 'own_cards']);

export const FreeZoneConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** 卡头规则文字，保留换行；前端最多显示三行 */
    rules_text: z.string().max(200).default(''),
    /** 福利期；为 null 时栏目不显示 */
    period: FreeZonePeriodSchema.nullable().default(null),
    scope: FreeZoneScopeSchema.default('all_cards'),
    candidates: z.array(FreeZoneCandidateSchema).max(50).default([]),
    screening: FreeZoneScreeningSchema.default({}),
    on_shelf: FreeZoneOnShelfSchema.default({}),
    relist: FreeZoneRelistSchema.default({}),
    first_token: FreeZoneFirstTokenSchema.default({}),
  })
  .superRefine((config, ctx) => {
    const ids = config.candidates.map((candidate) => candidate.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates'], message: '候选 id 重复' });
    }
    const models = config.candidates.map((candidate) => candidate.surplus_model.toLowerCase());
    if (new Set(models).size !== models.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates'],
        message: '同一个 Surplus 模型只能出现一次',
      });
    }
  });

export type FreeZoneCandidate = z.infer<typeof FreeZoneCandidateSchema>;
export type FreeZoneScreening = z.infer<typeof FreeZoneScreeningSchema>;
export type FreeZoneOnShelf = z.infer<typeof FreeZoneOnShelfSchema>;
export type FreeZoneRelist = z.infer<typeof FreeZoneRelistSchema>;
export type FreeZoneConfig = z.infer<typeof FreeZoneConfigSchema>;

export const DEFAULT_FREE_ZONE_CONFIG: FreeZoneConfig = FreeZoneConfigSchema.parse({});

// ── 公开契约 ──────────────────────────────────────────────────────────────

export const PublicFreeZoneModelSchema = z.object({
  id: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  tagline: z.string(),
  benchmark_tier: ModelCatalogTierKeySchema,
  /** 划线原价：对标档位当前的星尘价 */
  original_credits: z.number().int().nonnegative(),
});

const PublicFreeZoneBase = {
  rules: z.string(),
  models: z.array(PublicFreeZoneModelSchema),
};

/**
 * 栏目状态。open 写结束时间；未开放按原因区分：
 * not_started 写开始时间，own_card_only 是范围只限自创卡而当前是别人的卡，no_models 是没有在架模型。
 */
export const PublicFreeZoneSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open'), ends_at: IsoTimeSchema, ...PublicFreeZoneBase }),
  z.object({ state: z.literal('not_started'), starts_at: IsoTimeSchema, ...PublicFreeZoneBase }),
  z.object({ state: z.literal('own_card_only'), ...PublicFreeZoneBase }),
  z.object({ state: z.literal('no_models'), ...PublicFreeZoneBase }),
]);

export type PublicFreeZoneModel = z.infer<typeof PublicFreeZoneModelSchema>;
export type PublicFreeZone = z.infer<typeof PublicFreeZoneSchema>;
export type PublicFreeZoneState = PublicFreeZone['state'];
