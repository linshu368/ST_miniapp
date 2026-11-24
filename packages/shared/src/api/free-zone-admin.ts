import { z } from 'zod';

/** 运营平台畅聊页用的接口：候选模型的线上状态与上下架记录（只读），手动上架、下架。 */

/** cooling 是旧机制的状态，按未上架显示 */
export const FreeZoneModelStatusSchema = z.enum(['unlisted', 'listed']);

/**
 * Surplus 标的直购参考价（多为 OpenRouter 价），折扣就是相对它算的。
 * 单位：微美元 / 百万 token（900000 = 每百万 0.9 美元）。
 */
export const FreeZoneDirectPriceSchema = z.object({
  input_per_1m: z.number().nonnegative().nullable(),
  output_per_1m: z.number().nonnegative().nullable(),
  /** 参考价来源，例如 OpenRouter */
  source: z.string().nullable(),
});

export const AdminFreeZoneStatusModelSchema = z.object({
  candidate_id: z.string(),
  display_name: z.string().nullable(),
  surplus_model: z.string(),
  /** 已从候选池删掉、但状态表里还留着记录的为 false */
  in_config: z.boolean(),
  status: FreeZoneModelStatusSchema,
  /** 在架时固定的供应商 */
  providers: z.array(z.string()),
  provider_since: z.string().nullable(),
  /** 最近一次自动选供应商上架时 Surplus 标的原价；没有记录为 null */
  direct_price: FreeZoneDirectPriceSchema.nullable().default(null),
  /** 上过架没有（看上下架记录） */
  ever_listed: z.boolean().default(false),
  /** 最近一次下架：原因类别（official 连续拒单、null 运营手动、business 旧机制）、时间、原因 */
  last_delist: z
    .object({
      cause: z.enum(['official', 'business']).nullable(),
      at: z.string(),
      reason: z.string().nullable(),
    })
    .nullable()
    .default(null),
});

export const AdminFreeZoneEventSchema = z.object({
  candidate_id: z.string(),
  /** provider_switched、cooldown_ended 只出现在旧机制留下的记录里 */
  event_type: z.enum(['listed', 'provider_switched', 'delisted', 'cooldown_ended']),
  cause: z.enum(['official', 'business']).nullable(),
  providers: z.array(z.string()),
  reason: z.string().nullable(),
  created_at: z.string(),
});

export const AdminFreeZoneStatusResponseSchema = z.object({
  enabled: z.boolean(),
  models: z.array(AdminFreeZoneStatusModelSchema),
  events: z.array(AdminFreeZoneEventSchema),
});

/**
 * 运营手动「上架」：固定一家供应商，之后不自动变。不指定供应商时，按当前报价选
 * 达到折扣底线、可用的 trusted 供应商里折扣最高的一家。
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
  /** requested：运营指定的；market：按当前报价选的 */
  provider_source: z.enum(['requested', 'market']),
});

/**
 * 运营手动「下架」：在架模型立即下架，正在用它的用户下一轮自动换成别的免费模型。
 * 不会自动回来，要用时再点上架。不要求在候选池里：移出候选池后仍停在在架状态的行也能用它收掉。
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

export type FreeZoneModelStatus = z.infer<typeof FreeZoneModelStatusSchema>;
export type FreeZoneDirectPrice = z.infer<typeof FreeZoneDirectPriceSchema>;
export type AdminFreeZoneStatusModel = z.infer<typeof AdminFreeZoneStatusModelSchema>;
export type AdminFreeZoneStatusModelInput = z.input<typeof AdminFreeZoneStatusModelSchema>;
export type AdminFreeZoneEvent = z.infer<typeof AdminFreeZoneEventSchema>;
export type AdminFreeZoneStatusResponse = z.infer<typeof AdminFreeZoneStatusResponseSchema>;
export type AdminFreeZoneListNowRequest = z.input<typeof AdminFreeZoneListNowRequestSchema>;
export type AdminFreeZoneListNowResponse = z.infer<typeof AdminFreeZoneListNowResponseSchema>;
export type AdminFreeZoneDelistNowRequest = z.input<typeof AdminFreeZoneDelistNowRequestSchema>;
export type AdminFreeZoneDelistNowResponse = z.infer<typeof AdminFreeZoneDelistNowResponseSchema>;
