import { z } from 'zod';

/**
 * VIP 周卡/月卡的商业条款是产品拍板事实，不是运行时目录。
 * 文本模型原价仍由调用方传入，不得把 test 环境当前价写进本文件。
 */
export const VIP_TEXT_DISCOUNT_RATE = 0.95;

export const VipPlanIdSchema = z.enum(['week', 'month']);
export type VipPlanId = z.infer<typeof VipPlanIdSchema>;

export const VIP_PLAN_COMMERCIAL_TERMS = {
  week: {
    id: 'week',
    price_cents: 1399,
    duration_days: 7,
    bonus_credits: 0,
  },
  month: {
    id: 'month',
    price_cents: 2888,
    duration_days: 31,
    bonus_credits: 3000,
  },
} as const satisfies Record<
  VipPlanId,
  { id: VipPlanId; price_cents: number; duration_days: number; bonus_credits: number }
>;

const nonnegativeInteger = z.number().int().nonnegative();

export const VipPlanSchema = z
  .object({
    id: VipPlanIdSchema,
    price_cents: nonnegativeInteger,
    duration_days: nonnegativeInteger,
    bonus_credits: nonnegativeInteger,
    title: z.string().trim().min(1).max(40),
    description: z.string().trim().min(1).max(200).nullable(),
    badge_text: z.string().trim().min(1).max(40).nullable(),
    available: z.boolean(),
  })
  .superRefine((plan, ctx) => {
    const canonical = VIP_PLAN_COMMERCIAL_TERMS[plan.id];
    if (
      plan.price_cents !== canonical.price_cents ||
      plan.duration_days !== canonical.duration_days ||
      plan.bonus_credits !== canonical.bonus_credits
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'vip plan commercial terms must match the canonical week/month products',
      });
    }
  });

export type VipPlan = z.infer<typeof VipPlanSchema>;

export const VipPlansSchema = z
  .array(VipPlanSchema)
  .max(2)
  .superRefine((plans, ctx) => {
    const ids = plans.map((plan) => plan.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'vip plan ids must be unique',
      });
    }
  });

export const VipStatusSchema = z.object({
  active: z.boolean(),
  valid_from: z.string().min(1).nullable(),
  valid_until: z.string().min(1).nullable(),
  remaining_days: nonnegativeInteger,
  last_plan_id: VipPlanIdSchema.nullable(),
  entry_badge_visible: z.boolean(),
});

export type VipStatus = z.infer<typeof VipStatusSchema>;

/** 模型目录等只需要资格摘要；权限仍以 valid_until > now 为准，不看 remaining_days。 */
export const VipEntitlementSummarySchema = VipStatusSchema.pick({
  active: true,
  remaining_days: true,
  valid_until: true,
});

export type VipEntitlementSummary = z.infer<typeof VipEntitlementSummarySchema>;

export type GetVipStatusData = VipStatus;
export type MarkVipEntryViewedRequest = Record<never, never>;
export type MarkVipEntryViewedData = VipStatus;

export const VipReminderWindowSchema = z.enum(['expiring_soon', 'expires_today']);
export type VipReminderWindow = z.infer<typeof VipReminderWindowSchema>;

export const VIP_EXPIRY_NOTIFICATION_KIND = 'vip_expiry' as const;

export function isVipPlanId(value: string): value is VipPlanId {
  return value === 'week' || value === 'month';
}

export function canonicalVipPlanTerms(
  planId: VipPlanId
): (typeof VIP_PLAN_COMMERCIAL_TERMS)[VipPlanId] {
  return VIP_PLAN_COMMERCIAL_TERMS[planId];
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${label} timestamp`);
  }
  return parsed;
}

/** 权限判定只用精确截止时间，不用展示天数。 */
export function isVipActiveAt(validUntil: string | null, now: string): boolean {
  if (!validUntil) return false;
  return parseTimestamp(validUntil, 'valid_until') > parseTimestamp(now, 'now');
}

/** 仅用于「剩 N 天」展示：正剩余毫秒按整天向上取整；到期后为 0。 */
export function remainingVipDisplayDays(validUntil: string | null, now: string): number {
  if (!validUntil) return 0;
  const remainingMs = parseTimestamp(validUntil, 'valid_until') - parseTimestamp(now, 'now');
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 86_400_000);
}
