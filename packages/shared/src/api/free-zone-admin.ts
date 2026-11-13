import { z } from 'zod';
import { FreeZoneScreeningSchema } from './free-zone.js';

/**
 * 运营平台调试畅聊用的两个只读接口：
 * - 筛选预览：按运营页面上（可能还没保存的）初筛门槛，拿 Surplus 实时行情把候选池过一遍；
 * - 线上状态：评估任务落库的当前状态和最近的上下架记录。
 * 两者都不改任何状态，和评估任务用的是同一套初筛函数。
 */

/** 初筛里可以逐项检查的参数（折扣底线决定「达标报价」怎么数，价格分档倍数决定选哪家，不单列）。 */
export const FreeZoneScreeningCheckKeySchema = z.enum([
  'min_qualified_offers',
  'min_samples',
  'min_uptime_pct',
  'max_ttft_p50_ms',
  'max_ttft_p90_ms',
  'min_tps',
  'min_cache_hit_rate_pct',
  'min_realized_discount_pct',
  /** 派单探测：只在评估任务里有（筛选预览不发真实请求） */
  'probe',
]);

export const FreeZoneScreeningCheckSchema = z.object({
  key: FreeZoneScreeningCheckKeySchema,
  /** Surplus 给的实际值；null 表示平台没给 */
  value: z.number().nullable(),
  threshold: z.number().nullable(),
  /** null：这一项门槛留空，不检查 */
  pass: z.boolean().nullable(),
});

export const AdminFreeZoneScreeningRequestSchema = z.object({
  candidates: z
    .array(
      z.object({
        id: z.string().trim().max(64),
        surplus_model: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
        display_name: z.string().trim().max(40),
        /** 这个模型单独的折扣底线；不填用统一底线 */
        min_discount_pct: z.number().int().min(1).max(100).nullable().optional(),
      })
    )
    .min(1)
    .max(50),
  screening: FreeZoneScreeningSchema,
});

export const AdminFreeZoneProviderResultSchema = z.object({
  provider: z.string(),
  /** 这家每一项都过了 */
  qualified: z.boolean(),
  qualified_offers: z.number().int().nonnegative(),
  /** 达标报价里最便宜的价格（每百万 token，微美元） */
  price_per_1m: z.number().nullable(),
  checks: z.array(FreeZoneScreeningCheckSchema),
});

export const AdminFreeZoneModelResultSchema = z.object({
  candidate_id: z.string(),
  display_name: z.string(),
  surplus_model: z.string(),
  /** Surplus 行情没拿到时的说明；这种情况看不出达不达标 */
  error: z.string().nullable(),
  pass: z.boolean(),
  /** 现在新上架的话会选哪家（已在架的模型实际会粘住当前那家） */
  picked_provider: z.string().nullable(),
  /** 模型层的检查：7 天成交折扣 */
  model_checks: z.array(FreeZoneScreeningCheckSchema),
  providers: z.array(AdminFreeZoneProviderResultSchema),
  reasons: z.array(z.string()),
});

export const AdminFreeZoneParameterImpactSchema = z.object({
  key: FreeZoneScreeningCheckKeySchema,
  /** 只放开这一项（改成不检查；达标报价数按降到 1 算），会多达标的候选 id */
  unlocks: z.array(z.string()),
});

export const AdminFreeZoneScreeningResponseSchema = z.object({
  checked_at: z.string(),
  models: z.array(AdminFreeZoneModelResultSchema),
  impact: z.array(AdminFreeZoneParameterImpactSchema),
});

/** 评估任务每轮记下的逐项汇总：每一项有几家 trusted 供应商过了。 */
export const FreeZoneCheckSummarySchema = z.object({
  key: FreeZoneScreeningCheckKeySchema,
  /** null：这一项门槛留空，不检查 */
  threshold: z.number().nullable(),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const FreeZoneScreeningSummarySchema = z.object({
  pass: z.boolean(),
  checks: z.array(FreeZoneCheckSummarySchema),
  /** 没过的项最少的那家供应商，以及它没过哪几项（每项都有人过、却没有一家全过时看这个） */
  closest: z
    .object({ provider: z.string(), failed: z.array(FreeZoneScreeningCheckKeySchema) })
    .nullable(),
});

/** 一次派单探测的结果 */
export const FreeZoneProbeSchema = z.object({
  provider: z.string(),
  /** ok：派出去了；unroutable：折扣底线达不到 / 没有可用卖家；error：网络等说不清的失败（本轮维持现状） */
  outcome: z.enum(['ok', 'unroutable', 'error']),
  /** 首个字（正文或思考）出现的耗时；超时为探测上限 */
  first_token_ms: z.number().nonnegative().nullable(),
  detail: z.string().nullable(),
});

export const FreeZoneModelStatusSchema = z.enum(['unlisted', 'listed', 'cooling']);

/**
 * 在架模型最近一轮评估时的真实业务数据：只统计当前供应商开始用之后、统计窗口内的轮次。
 * 百分比都是 0–100；没有样本的项为 null。
 */
export const FreeZoneBusinessSnapshotSchema = z.object({
  turns: z.number().int().nonnegative(),
  fallback_delivered_pct: z.number().nullable().default(null),
  no_output_pct: z.number().nullable().default(null),
  /** 免费模型自己交付的轮次（中断率的分母） */
  primary_delivered_turns: z.number().int().nonnegative().nullable().default(null),
  interrupted_turns: z.number().int().nonnegative().nullable().default(null),
  /** 开始出字后没写完就断了 / 免费模型自己交付的轮次；新字段上线前的评估记录为 null */
  interrupted_pct: z.number().nullable().default(null),
  ttft_p90_ms: z.number().nullable().default(null),
});

export const AdminFreeZoneStatusModelSchema = z.object({
  candidate_id: z.string(),
  display_name: z.string().nullable(),
  surplus_model: z.string(),
  /** 已从候选池删掉、但状态表里还留着记录的为 false */
  in_config: z.boolean(),
  /** null：还没被评估过 */
  status: FreeZoneModelStatusSchema.nullable(),
  providers: z.array(z.string()),
  provider_since: z.string().nullable(),
  consecutive_passes: z.number().int().nonnegative(),
  cooldown_until: z.string().nullable(),
  /** 因业务越线被排除的供应商 → 排除到期时间 */
  excluded_providers: z.record(z.string()),
  last_reason: z.string().nullable(),
  /** 最近一轮官方初筛的逐项汇总；新字段上线前评估的记录为 null */
  screening: FreeZoneScreeningSummarySchema.nullable(),
  /** 在架模型最近一轮评估时的业务数据；不在架或还没数据为 null */
  business: FreeZoneBusinessSnapshotSchema.nullable().default(null),
  /** 最近一轮评估里，最终选定（或在用）的那家供应商的探测结果 */
  probe: FreeZoneProbeSchema.nullable().default(null),
  /** 上过架没有（看上下架记录） */
  ever_listed: z.boolean().default(false),
  /** 最近一次下架：原因类别、时间、原因；从没下架过为 null */
  last_delist: z
    .object({
      cause: z.enum(['official', 'business']).nullable(),
      at: z.string(),
      reason: z.string().nullable(),
    })
    .nullable()
    .default(null),
  evaluated_at: z.string().nullable(),
});

export const AdminFreeZoneEventSchema = z.object({
  candidate_id: z.string(),
  event_type: z.enum(['listed', 'provider_switched', 'delisted', 'cooldown_ended']),
  cause: z.enum(['official', 'business']).nullable(),
  providers: z.array(z.string()),
  reason: z.string().nullable(),
  created_at: z.string(),
});

export const AdminFreeZoneStatusResponseSchema = z.object({
  enabled: z.boolean(),
  required_passes: z.number().int().positive(),
  last_evaluated_at: z.string().nullable(),
  models: z.array(AdminFreeZoneStatusModelSchema),
  events: z.array(AdminFreeZoneEventSchema),
});

/**
 * 运营手动「立即上架」：跳过连续达标次数和冷却期，直接用一家供应商上架；之后照常每 30 分钟评估，
 * 官方数据或业务数据不达标照样会换供应商或下架。不指定供应商时按当前行情和初筛门槛选。
 */
export const AdminFreeZoneListNowRequestSchema = z.object({
  candidate_id: z.string().trim().min(1).max(64),
  provider: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, '供应商名只能是小写字母、数字和 . _ -')
    .optional(),
});

export const AdminFreeZoneListNowResponseSchema = z.object({
  candidate_id: z.string(),
  display_name: z.string(),
  provider: z.string(),
  /** requested：运营指定的；screening：按当前初筛结果选的 */
  provider_source: z.enum(['requested', 'screening']),
  /** 上架前的状态；null 表示还没被评估过 */
  previous_status: FreeZoneModelStatusSchema.nullable(),
});

/**
 * 运营手动「下架」：在架模型立即下架，正在用它的用户下一轮自动换成别的免费模型。
 * 不会被评估任务自动加回来（冷却截止设到很远），要用时走「立即上架」。
 * 不要求在候选池里：移出候选池后仍停在在架状态的行也能用它收掉。
 */
export const AdminFreeZoneDelistNowRequestSchema = z.object({
  candidate_id: z.string().trim().min(1).max(64),
});

export const AdminFreeZoneDelistNowResponseSchema = z.object({
  candidate_id: z.string(),
  display_name: z.string(),
  /** 下架前在用的供应商 */
  providers: z.array(z.string()),
});

export type FreeZoneScreeningCheckKey = z.infer<typeof FreeZoneScreeningCheckKeySchema>;
export type FreeZoneScreeningCheck = z.infer<typeof FreeZoneScreeningCheckSchema>;
export type FreeZoneCheckSummary = z.infer<typeof FreeZoneCheckSummarySchema>;
export type FreeZoneProbe = z.infer<typeof FreeZoneProbeSchema>;
export type FreeZoneBusinessSnapshot = z.infer<typeof FreeZoneBusinessSnapshotSchema>;
export type FreeZoneScreeningSummary = z.infer<typeof FreeZoneScreeningSummarySchema>;
export type AdminFreeZoneScreeningRequest = z.input<typeof AdminFreeZoneScreeningRequestSchema>;
export type AdminFreeZoneModelResult = z.infer<typeof AdminFreeZoneModelResultSchema>;
export type AdminFreeZoneProviderResult = z.infer<typeof AdminFreeZoneProviderResultSchema>;
export type AdminFreeZoneScreeningResponse = z.infer<typeof AdminFreeZoneScreeningResponseSchema>;
export type AdminFreeZoneStatusModel = z.infer<typeof AdminFreeZoneStatusModelSchema>;
export type AdminFreeZoneStatusModelInput = z.input<typeof AdminFreeZoneStatusModelSchema>;
export type AdminFreeZoneEvent = z.infer<typeof AdminFreeZoneEventSchema>;
export type AdminFreeZoneStatusResponse = z.infer<typeof AdminFreeZoneStatusResponseSchema>;
export type AdminFreeZoneListNowRequest = z.input<typeof AdminFreeZoneListNowRequestSchema>;
export type AdminFreeZoneListNowResponse = z.infer<typeof AdminFreeZoneListNowResponseSchema>;
export type AdminFreeZoneDelistNowRequest = z.input<typeof AdminFreeZoneDelistNowRequestSchema>;
export type AdminFreeZoneDelistNowResponse = z.infer<typeof AdminFreeZoneDelistNowResponseSchema>;
