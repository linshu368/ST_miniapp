import { z } from 'zod';
import { LlmModelProviderSchema } from './model-providers.js';
import { ModelCatalogTierKeySchema, type ModelCatalogTierKey } from './model-catalog.js';
export * from './model-catalog.js';
export {
  LLM_MODEL_PROVIDERS,
  LLM_MODEL_PROVIDER_LABELS,
  LLM_PROVIDER_CAPABILITIES,
  LlmModelProviderSchema,
  type LlmModelProvider,
  type LlmProviderCapability,
} from './model-providers.js';

import { VIP_TEXT_DISCOUNT_RATE } from './vip.js';
import { VipTextDiscountRateSchema } from './vip-strategy.js';
import {
  resolveBillableCapabilityRules,
  type WalletDebitPolicy,
  type WalletContractResult,
} from './wallet.js';

export const OpenRouterModelSchema = z.object({
  id: z.string().trim().min(1),
  canonical_slug: z.string().trim().min(1).nullable().optional(),
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  context_length: z.number().int().nonnegative().nullable().optional(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
  expiration_date: z.string().nullable().optional(),
});

export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
});

export const OpenRouterModelSummarySchema = z.object({
  id: z.string().trim().min(1),
  canonical_slug: z.string().trim().min(1).nullable(),
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  context_length: z.number().int().nonnegative().nullable(),
  prompt_usd_per_token: z.number().finite().nonnegative(),
  completion_usd_per_token: z.number().finite().nonnegative(),
  expiration_date: z.string().nullable(),
});

export const OpenRouterModelDirectorySchema = z.object({
  models: z.array(OpenRouterModelSummarySchema),
  fetched_at: z.string().datetime(),
  stale: z.boolean(),
});

export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;
export type OpenRouterModelSummary = z.infer<typeof OpenRouterModelSummarySchema>;
export type OpenRouterModelDirectory = z.infer<typeof OpenRouterModelDirectorySchema>;

export const ProviderModelSummarySchema = z.object({
  provider: LlmModelProviderSchema,
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  context_length: z.number().int().nonnegative().nullable(),
  prompt_usd_per_token: z.number().finite().nonnegative(),
  completion_usd_per_token: z.number().finite().nonnegative(),
  status: z.enum(['available', 'unavailable', 'expired']),
  raw_status_label: z.string().trim().min(1).nullable(),
  /** Optional model-level capability names; these do not promise accepted effort values. */
  supported_parameters: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
    .max(128)
    .optional(),
});

export const ProviderModelDirectorySchema = z.object({
  provider: LlmModelProviderSchema,
  models: z.array(ProviderModelSummarySchema),
  fetched_at: z.string().datetime(),
  stale: z.boolean(),
});

export type ProviderModelSummary = z.infer<typeof ProviderModelSummarySchema>;
export type ProviderModelDirectory = z.infer<typeof ProviderModelDirectorySchema>;

export const FixedDeductionConfigSchema = z.object({
  freeQuotaExhausted: z.number().finite().nonnegative(),
  light: z.number().finite().nonnegative(),
  standard: z.number().finite().nonnegative(),
  premium: z.number().finite().nonnegative(),
});

export const LlmPricingConfigSchema = z.object({
  fixedDeduction: FixedDeductionConfigSchema,
});

export type FixedDeductionConfig = z.infer<typeof FixedDeductionConfigSchema>;
export type LlmPricingRuntimeConfig = z.infer<typeof LlmPricingConfigSchema>;

export interface InsufficientBalanceErrorResponse {
  error: {
    message: string;
    type: 'insufficient_balance';
    credits_required: number;
    credits_available: number;
  };
}

export interface TextModelUsageQuote {
  original_credits: number;
  discount_applied: boolean;
  discount_rate: number | null;
  discounted_exact: number;
  payable_credits: number;
  wallet_policy: WalletDebitPolicy;
  requires_vip: boolean;
  discount_source?: 'vip' | 'creator' | null;
}

export const CHARACTER_CREATOR_SELF_DISCOUNT_RATE = 0.8;

export type QuoteTextModelUsageResult = WalletContractResult<
  TextModelUsageQuote,
  'INVALID_PRICE' | 'UNSUPPORTED_TIER'
>;

function textCapabilityForTier(tier: ModelCatalogTierKey) {
  if (tier === 'light') return 'text_light' as const;
  if (tier === 'standard') return 'text_standard' as const;
  return 'text_premium' as const;
}

/** 非负有限值的四舍五入（0.5 进位）；文本实扣必须是整数。 */
export function roundHalfUpToInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('payable credits must be a non-negative finite number');
  }
  return Math.round(value);
}

/**
 * 免费轮优先；自用与 VIP 取更优折扣，不叠加，也不改变 VIP 模型资格。
 * 省略折扣率时使用 0.95。不读取 runtime config，也不把 test 目录价写死。
 */
export function quoteTextModelUsage(input: {
  original_credits: number;
  is_vip: boolean;
  is_free_round: boolean;
  tier: ModelCatalogTierKey;
  discount_rate?: number;
  creator_self?: boolean;
}): QuoteTextModelUsageResult {
  const tierParsed = ModelCatalogTierKeySchema.safeParse(input.tier);
  if (!tierParsed.success) {
    return { ok: false, code: 'UNSUPPORTED_TIER', message: 'text model tier is not supported' };
  }
  if (!Number.isFinite(input.original_credits) || input.original_credits < 0) {
    return {
      ok: false,
      code: 'INVALID_PRICE',
      message: 'original credits must be a non-negative finite number',
    };
  }
  if (!Number.isInteger(input.original_credits)) {
    return {
      ok: false,
      code: 'INVALID_PRICE',
      message: 'original credits must be an integer snapshot',
    };
  }

  const rules = resolveBillableCapabilityRules(textCapabilityForTier(tierParsed.data));
  const originalCredits = input.original_credits;
  const discountRate =
    input.discount_rate === undefined ? VIP_TEXT_DISCOUNT_RATE : input.discount_rate;
  if (
    input.discount_rate !== undefined &&
    !VipTextDiscountRateSchema.safeParse(discountRate).success
  ) {
    return {
      ok: false,
      code: 'INVALID_PRICE',
      message: 'discount rate must be greater than 0 and at most 1',
    };
  }

  if (input.is_free_round) {
    return {
      ok: true,
      value: {
        original_credits: originalCredits,
        discount_applied: false,
        discount_rate: null,
        discounted_exact: 0,
        payable_credits: 0,
        wallet_policy: rules.wallet_policy,
        requires_vip: rules.requires_vip,
      },
    };
  }

  if (!input.is_vip && !input.creator_self) {
    return {
      ok: true,
      value: {
        original_credits: originalCredits,
        discount_applied: false,
        discount_rate: null,
        discounted_exact: originalCredits,
        payable_credits: originalCredits,
        wallet_policy: rules.wallet_policy,
        requires_vip: rules.requires_vip,
      },
    };
  }

  const vipRate = input.is_vip ? discountRate : 1;
  const effectiveRate = input.creator_self
    ? Math.min(vipRate, CHARACTER_CREATOR_SELF_DISCOUNT_RATE)
    : vipRate;
  const discountedExact = originalCredits * effectiveRate;
  return {
    ok: true,
    value: {
      original_credits: originalCredits,
      discount_applied: true,
      discount_rate: effectiveRate,
      ...(input.creator_self
        ? {
            discount_source:
              vipRate < CHARACTER_CREATOR_SELF_DISCOUNT_RATE
                ? ('vip' as const)
                : ('creator' as const),
          }
        : {}),
      discounted_exact: discountedExact,
      payable_credits: roundHalfUpToInteger(discountedExact),
      wallet_policy: rules.wallet_policy,
      requires_vip: rules.requires_vip,
    },
  };
}
