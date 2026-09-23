import { z } from 'zod';

/**
 * 语音与基础图片各自独立的免费成功次数。高级图片不参与。
 * 3 是首次 seed 和配置损坏时的默认；已发布上限为 0..20，0 表示关闭该功能的免费体验。
 */
export const FEATURE_FREE_TRIAL_LIMIT_MIN = 0;
export const FEATURE_FREE_TRIAL_LIMIT_MAX = 20;
export const FEATURE_FREE_TRIAL_LIMIT = 3;

export const FeatureFreeTrialFeatureSchema = z.enum(['voice', 'basic_image']);
export type FeatureFreeTrialFeature = z.infer<typeof FeatureFreeTrialFeatureSchema>;

/**
 * 公共状态语义，供后续 DB 状态机复用，本身不执行预留/消费：
 * - reserved：已占名额，成功前不计 used
 * - consumed：成功消费，计 used
 * - released：失败/取消释放，不占名额
 */
export const FeatureFreeTrialStatusSchema = z.enum(['reserved', 'consumed', 'released']);
export type FeatureFreeTrialStatus = z.infer<typeof FeatureFreeTrialStatusSchema>;

export const FeatureFreeTrialErrorCodeSchema = z.enum([
  'FEATURE_FREE_TRIAL_EXHAUSTED',
  'FEATURE_FREE_TRIAL_CONFLICT',
  'FEATURE_FREE_TRIAL_INVALID_STATE',
]);
export type FeatureFreeTrialErrorCode = z.infer<typeof FeatureFreeTrialErrorCodeSchema>;

export const ADVANCED_IMAGE_UNAVAILABLE_ERROR_CODE = 'ADVANCED_IMAGE_UNAVAILABLE' as const;

export const ImageGenerationTierSchema = z.enum(['basic', 'advanced']);
export type ImageGenerationTier = z.infer<typeof ImageGenerationTierSchema>;

export const FeatureFreeTrialLimitSchema = z
  .number()
  .int()
  .min(FEATURE_FREE_TRIAL_LIMIT_MIN)
  .max(FEATURE_FREE_TRIAL_LIMIT_MAX);
export type FeatureFreeTrialLimit = z.infer<typeof FeatureFreeTrialLimitSchema>;

/** 事实序号允许到受控上限。当前发布值可以低于历史序号，不能把旧事实判成非法。 */
export const FeatureFreeTrialOrdinalSchema = z
  .number()
  .int()
  .min(1)
  .max(FEATURE_FREE_TRIAL_LIMIT_MAX);
export type FeatureFreeTrialOrdinal = z.infer<typeof FeatureFreeTrialOrdinalSchema>;

export const FeatureFreeTrialFactSchema = z.object({
  feature: FeatureFreeTrialFeatureSchema,
  reference_id: z.string().trim().min(1),
  ordinal: FeatureFreeTrialOrdinalSchema,
  status: FeatureFreeTrialStatusSchema,
});

export type FeatureFreeTrialFact = z.infer<typeof FeatureFreeTrialFactSchema>;

export const FeatureFreeTrialQuotaViewSchema = z.object({
  feature: FeatureFreeTrialFeatureSchema,
  free_trial_limit: FeatureFreeTrialLimitSchema,
  free_trials_used: z.number().int().nonnegative(),
  free_trials_reserved: z.number().int().nonnegative(),
  free_trials_remaining: z.number().int().nonnegative(),
  next_trial_ordinal: FeatureFreeTrialOrdinalSchema.nullable(),
});

export type FeatureFreeTrialQuotaView = z.infer<typeof FeatureFreeTrialQuotaViewSchema>;

export function featureFreeTrialOccupiesSlot(status: FeatureFreeTrialStatus): boolean {
  return status === 'reserved' || status === 'consumed';
}

export function isFeatureFreeTrialExhausted(quota: FeatureFreeTrialQuotaView): boolean {
  return quota.free_trials_remaining === 0;
}

export type FeatureFreeTrialQuotaResult =
  | { ok: true; quota: FeatureFreeTrialQuotaView }
  | { ok: false; code: FeatureFreeTrialErrorCode; message: string };

/**
 * 把 reserved/consumed/released 事实折叠成展示额度。
 * 不推进状态：reserved 占名额但不计入 used；released 两者都不计入。
 */
export function summarizeFeatureFreeTrialQuota(input: {
  feature: FeatureFreeTrialFeature;
  facts: ReadonlyArray<Pick<FeatureFreeTrialFact, 'ordinal' | 'status'>>;
  /** 省略时使用安全默认 3。0 表示不再分配，但已有事实仍计入 used。 */
  limit?: number;
}): FeatureFreeTrialQuotaResult {
  const limitParsed = FeatureFreeTrialLimitSchema.safeParse(
    input.limit ?? FEATURE_FREE_TRIAL_LIMIT
  );
  if (!limitParsed.success) {
    return {
      ok: false,
      code: 'FEATURE_FREE_TRIAL_INVALID_STATE',
      message: 'free trial limit is invalid',
    };
  }
  const freeTrialLimit = limitParsed.data;
  const occupying = new Map<number, FeatureFreeTrialStatus>();
  let used = 0;
  let reserved = 0;

  for (const fact of input.facts) {
    const ordinalParsed = FeatureFreeTrialOrdinalSchema.safeParse(fact.ordinal);
    const statusParsed = FeatureFreeTrialStatusSchema.safeParse(fact.status);
    if (!ordinalParsed.success || !statusParsed.success) {
      return {
        ok: false,
        code: 'FEATURE_FREE_TRIAL_INVALID_STATE',
        message: 'free trial ordinal or status is invalid',
      };
    }

    if (!featureFreeTrialOccupiesSlot(statusParsed.data)) {
      continue;
    }

    const existing = occupying.get(ordinalParsed.data);
    if (existing && existing !== statusParsed.data) {
      return {
        ok: false,
        code: 'FEATURE_FREE_TRIAL_CONFLICT',
        message: 'the same free-trial ordinal cannot occupy more than one slot',
      };
    }
    occupying.set(ordinalParsed.data, statusParsed.data);
  }

  for (const status of occupying.values()) {
    if (status === 'consumed') used += 1;
    if (status === 'reserved') reserved += 1;
  }

  const remaining = Math.max(0, freeTrialLimit - occupying.size);
  let nextTrialOrdinal: FeatureFreeTrialOrdinal | null = null;
  if (occupying.size < freeTrialLimit) {
    for (let ordinal = 1; ordinal <= FEATURE_FREE_TRIAL_LIMIT_MAX; ordinal += 1) {
      if (!occupying.has(ordinal)) {
        nextTrialOrdinal = ordinal as FeatureFreeTrialOrdinal;
        break;
      }
    }
  }

  return {
    ok: true,
    quota: {
      feature: input.feature,
      free_trial_limit: freeTrialLimit,
      free_trials_used: used,
      free_trials_reserved: reserved,
      free_trials_remaining: remaining,
      next_trial_ordinal: nextTrialOrdinal,
    },
  };
}
