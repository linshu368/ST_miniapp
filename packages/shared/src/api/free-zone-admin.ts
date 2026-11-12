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

export const FreeZoneModelStatusSchema = z.enum(['unlisted', 'listed', 'cooling']);

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

export type FreeZoneScreeningCheckKey = z.infer<typeof FreeZoneScreeningCheckKeySchema>;
export type FreeZoneScreeningCheck = z.infer<typeof FreeZoneScreeningCheckSchema>;
export type AdminFreeZoneScreeningRequest = z.input<typeof AdminFreeZoneScreeningRequestSchema>;
export type AdminFreeZoneModelResult = z.infer<typeof AdminFreeZoneModelResultSchema>;
export type AdminFreeZoneProviderResult = z.infer<typeof AdminFreeZoneProviderResultSchema>;
export type AdminFreeZoneScreeningResponse = z.infer<typeof AdminFreeZoneScreeningResponseSchema>;
export type AdminFreeZoneStatusModel = z.infer<typeof AdminFreeZoneStatusModelSchema>;
export type AdminFreeZoneEvent = z.infer<typeof AdminFreeZoneEventSchema>;
export type AdminFreeZoneStatusResponse = z.infer<typeof AdminFreeZoneStatusResponseSchema>;
