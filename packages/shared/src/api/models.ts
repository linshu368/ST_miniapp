import { z } from 'zod';

/**
 * Legacy model-switcher contract. Keep this shape stable while consumers move
 * to the catalog endpoint.
 */
export interface ModelTierConfig {
  tier: string;
  modelName: string;
  provider: string;
  label: string;
  deductionRate: number;
  isDefault?: boolean;
}

export interface GetModelTiersData {
  tiers: ModelTierConfig[];
}

export const ModelCatalogTierKeySchema = z.enum(['light', 'standard', 'premium']);

export const ModelCatalogModelSchema = z.object({
  /** Stable application-facing identifier. */
  id: z.string().trim().min(1),
  /** Provider-facing model identifier passed to the OpenRouter bridge. */
  openrouter_model_id: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  tagline: z.string().max(15),
  /** Display-only prices; billing must use provider usage data instead. */
  price_input: z.number().finite().nonnegative(),
  price_output: z.number().finite().nonnegative(),
  enabled: z.boolean(),
  sort_order: z.number().finite(),
});

export const ModelCatalogTierSchema = z.object({
  tier: ModelCatalogTierKeySchema,
  label: z.string().trim().min(1),
  color: z.string().trim().min(1),
  cost_hint: z.string(),
  sort_order: z.number().finite(),
  models: z.array(ModelCatalogModelSchema),
});

export const ModelCatalogSchema = z
  .object({
    default_model_id: z.string().trim().min(1),
    tiers: z.array(ModelCatalogTierSchema),
  })
  .superRefine((catalog, ctx) => {
    const tierKeys = catalog.tiers.map((tier) => tier.tier);
    if (new Set(tierKeys).size !== tierKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'tier keys must be unique',
      });
    }

    const models = catalog.tiers.flatMap((tier) => tier.models);
    const modelIds = models.map((model) => model.id);
    const uniqueModelIds = new Set(modelIds);

    if (uniqueModelIds.size !== modelIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'model ids must be unique',
      });
    }

    const openRouterModelIds = models.map((model) => model.openrouter_model_id);
    if (new Set(openRouterModelIds).size !== openRouterModelIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'openrouter_model_id values must be unique',
      });
    }

    const defaultModel = models.find((model) => model.id === catalog.default_model_id);
    if (!defaultModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_model_id'],
        message: 'default_model_id must identify a catalog model',
      });
    } else if (!defaultModel.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_model_id'],
        message: 'default_model_id must identify an enabled model',
      });
    }
  });

export type ModelCatalogTierKey = z.infer<typeof ModelCatalogTierKeySchema>;
export type ModelCatalogModel = z.infer<typeof ModelCatalogModelSchema>;
export type ModelCatalogTier = z.infer<typeof ModelCatalogTierSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

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

export interface DisplayPricingConfig {
  exchangeRate: number;
  markup: number;
}

export function calculateDisplayPrice(usdPerToken: number, pricing: DisplayPricingConfig): number {
  if (
    !Number.isFinite(usdPerToken) ||
    usdPerToken < 0 ||
    !Number.isFinite(pricing.exchangeRate) ||
    pricing.exchangeRate <= 0 ||
    !Number.isFinite(pricing.markup) ||
    pricing.markup <= 0
  ) {
    throw new Error('invalid OpenRouter display price inputs');
  }

  return Math.round(usdPerToken * 10_000 * pricing.exchangeRate * pricing.markup * 10) / 10;
}

export function resolveEnabledCatalogModel(
  catalog: ModelCatalog,
  stableModelId: string
): ModelCatalogModel {
  const model = catalog.tiers
    .flatMap((tier) => tier.models)
    .find((candidate) => candidate.id === stableModelId);

  if (!model) throw new Error(`unknown model id: ${stableModelId}`);
  if (!model.enabled) throw new Error(`model is disabled: ${stableModelId}`);
  return model;
}

export interface InsufficientBalanceErrorResponse {
  error: {
    message: string;
    type: 'insufficient_balance';
    credits_required: number;
    credits_available: number;
  };
}
