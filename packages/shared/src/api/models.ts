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
export const StableModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'stable model id must use lowercase letters, numbers, dots, underscores or hyphens'
  );
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a six-digit hex value');
const oneDecimalDisplayPrice = z.number().finite().nonnegative().multipleOf(0.1);
export const MODEL_MARKUP_OPTIONS = [0, 1, 1.5, 2, 2.5, 3, 3.5, 4] as const;
export const MODEL_DEDUCT_MARKUP_OPTIONS = [1, 1.5, 2, 2.5, 3, 3.5, 4] as const;
export const ModelMarkupSchema = z
  .number()
  .refine(
    (value): value is (typeof MODEL_MARKUP_OPTIONS)[number] =>
      MODEL_MARKUP_OPTIONS.includes(value as (typeof MODEL_MARKUP_OPTIONS)[number]),
    'markup must be 0 or a half-step from 1 through 4'
  );
export const ModelDeductMarkupSchema = z
  .number()
  .refine(
    (value): value is (typeof MODEL_DEDUCT_MARKUP_OPTIONS)[number] =>
      MODEL_DEDUCT_MARKUP_OPTIONS.includes(value as (typeof MODEL_DEDUCT_MARKUP_OPTIONS)[number]),
    'deduct_markup must be a half-step from 1 through 4'
  );

export const ModelCatalogModelSchema = z.object({
  /** Stable application-facing identifier. */
  id: StableModelIdSchema,
  /** Provider-facing model identifier passed to the OpenRouter bridge. */
  openrouter_model_id: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .regex(/^[^\s/]+\/[^\s/]+$/),
  display_name: z.string().trim().min(1).max(40),
  /** 介绍语：说明模型适用场景的短句，展示在模型名称下方。 */
  tagline: z.string().trim().min(1).max(40),
  /** Display-only prices; billing must use provider usage data instead. */
  price_input: oneDecimalDisplayPrice,
  price_output: oneDecimalDisplayPrice,
  /** Default multiplier; zero identifies a model with an initial free quota. */
  markup: ModelMarkupSchema.default(2.5),
  /** Multiplier used after a free model's per-character quota is exhausted. */
  deduct_markup: ModelDeductMarkupSchema.optional(),
  enabled: z.boolean(),
  sort_order: z.number().int().nonnegative(),
});

export const ModelCatalogTierSchema = z.object({
  tier: ModelCatalogTierKeySchema,
  label: z.string().trim().min(1).max(20),
  color: HexColorSchema,
  cost_hint: z.string().trim().min(1).max(50),
  sort_order: z.number().int().nonnegative(),
  models: z.array(ModelCatalogModelSchema).min(1),
});

export const ModelCatalogSchema = z
  .object({
    default_model_id: z.string().trim().min(1),
    tiers: z.array(ModelCatalogTierSchema).min(1),
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
    catalog.tiers.forEach((tier, tierIndex) => {
      tier.models.forEach((model, modelIndex) => {
        if (model.markup === 0 && (model.price_input !== 0 || model.price_output !== 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tiers', tierIndex, 'models', modelIndex, 'price_input'],
            message: 'free models must have zero display prices',
          });
        }
        if (model.markup === 0 && model.deduct_markup === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tiers', tierIndex, 'models', modelIndex, 'deduct_markup'],
            message: 'free models must have a deduct_markup',
          });
        }
        if (model.markup !== 0 && model.deduct_markup !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tiers', tierIndex, 'models', modelIndex, 'deduct_markup'],
            message: 'paid models must not have a deduct_markup',
          });
        }
      });
    });
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

export const PublicModelCatalogModelSchema = ModelCatalogModelSchema.omit({
  openrouter_model_id: true,
  markup: true,
  deduct_markup: true,
  enabled: true,
}).extend({
  is_free: z.boolean().readonly(),
});

export const PublicModelCatalogTierSchema = z.object({
  key: ModelCatalogTierKeySchema,
  label: z.string().trim().min(1),
  color: z.string().trim().min(1),
  cost_hint: z.string(),
  sort_order: z.number().finite(),
  models: z.array(PublicModelCatalogModelSchema),
});

export const PublicModelCatalogSchema = z.object({
  default_model_id: z.string().trim().min(1),
  tiers: z.array(PublicModelCatalogTierSchema),
});

export const GetModelCatalogDataSchema = z.object({
  catalog: PublicModelCatalogSchema,
  selected_model_id: z.string().trim().min(1),
  selected_openrouter_model_id: z.string().trim().min(1),
  catalog_version: z.number().int().nonnegative(),
});

export const SelectModelRequestSchema = z.object({
  model_id: z.string().trim().min(1),
});

export const SelectModelDataSchema = z.object({
  model_id: z.string().trim().min(1),
  openrouter_model_id: z.string().trim().min(1),
});

export type PublicModelCatalogModel = z.infer<typeof PublicModelCatalogModelSchema>;
export type PublicModelCatalogTier = z.infer<typeof PublicModelCatalogTierSchema>;
export type PublicModelCatalog = z.infer<typeof PublicModelCatalogSchema>;
export type GetModelCatalogData = z.infer<typeof GetModelCatalogDataSchema>;
export type SelectModelRequest = z.infer<typeof SelectModelRequestSchema>;
export type SelectModelData = z.infer<typeof SelectModelDataSchema>;

const RuntimeCatalogModelSchema = z.object({
  id: z.string().trim().min(1),
  openrouter_model_id: z.string().trim().min(1),
  markup: ModelMarkupSchema.optional(),
  deduct_markup: ModelDeductMarkupSchema.optional(),
  enabled: z.boolean().optional().default(true),
});

const RuntimeModelCatalogSchema = z.object({
  default_model_id: z.string().trim().min(1),
  tiers: z
    .array(
      z.object({
        models: z.array(RuntimeCatalogModelSchema),
      })
    )
    .min(1),
});

export interface RuntimeCatalogModel {
  id: string;
  openrouter_model_id: string;
}

export function resolveRuntimeCatalogMarkup(
  value: unknown,
  openRouterModelId: string,
  fallbackMarkup: number
): number {
  const parsed = RuntimeModelCatalogSchema.safeParse(value);
  if (!parsed.success) return fallbackMarkup;
  const model = parsed.data.tiers
    .flatMap((tier) => tier.models)
    .find((candidate) => candidate.openrouter_model_id === openRouterModelId);
  return model?.markup ?? fallbackMarkup;
}

/**
 * Read only the fields required to provision ST. This intentionally ignores
 * display-only validation so catalogs published before UI schema tightening
 * remain usable without conflating stable ids with provider ids.
 */
export function resolveRuntimeCatalogModel(
  value: unknown,
  selectedModelId?: string | null,
  fallbackToDefault = true
): RuntimeCatalogModel | null {
  const parsed = RuntimeModelCatalogSchema.safeParse(value);
  if (!parsed.success) return null;

  const models = parsed.data.tiers.flatMap((tier) => tier.models);
  const requestedId =
    selectedModelId && models.some((model) => model.id === selectedModelId && model.enabled)
      ? selectedModelId
      : fallbackToDefault
        ? parsed.data.default_model_id
        : null;
  if (!requestedId) return null;

  const model = models.find((candidate) => candidate.id === requestedId && candidate.enabled);
  return model ? { id: model.id, openrouter_model_id: model.openrouter_model_id } : null;
}

export function toPublicModelCatalog(catalog: ModelCatalog): PublicModelCatalog {
  return PublicModelCatalogSchema.parse({
    default_model_id: catalog.default_model_id,
    tiers: catalog.tiers
      .map((tier) => ({
        key: tier.tier,
        label: tier.label,
        color: tier.color,
        cost_hint: tier.cost_hint,
        sort_order: tier.sort_order,
        models: tier.models
          .filter((model) => model.enabled)
          .map(
            ({ openrouter_model_id: _openrouterModelId, enabled: _enabled, markup, ...model }) => ({
              ...model,
              price_input: markup === 0 ? 0 : model.price_input,
              price_output: markup === 0 ? 0 : model.price_output,
              is_free: markup === 0,
            })
          ),
      }))
      .filter((tier) => tier.models.length > 0),
  });
}

export function resolveEffectiveSelectedModelId(
  catalog: ModelCatalog,
  selectedModelId: string | null | undefined
): string {
  if (selectedModelId) {
    const selected = catalog.tiers
      .flatMap((tier) => tier.models)
      .find((model) => model.id === selectedModelId && model.enabled);
    if (selected) return selected.id;
  }
  return resolveEnabledCatalogModel(catalog, catalog.default_model_id).id;
}

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

export const FixedDeductionConfigSchema = z.object({
  freeQuotaExhausted: z.number().finite().nonnegative(),
  standard: z.number().finite().nonnegative(),
  premium: z.number().finite().nonnegative(),
});

export const LlmPricingConfigSchema = z.object({
  balanceBaseline: z.number().finite().nonnegative(),
  fallbackCost: z.number().finite().nonnegative(),
  exchangeRate: z.number().finite().positive(),
  markup: z.number().finite().positive(),
  fixedDeduction: FixedDeductionConfigSchema,
});

export type FixedDeductionConfig = z.infer<typeof FixedDeductionConfigSchema>;
export type LlmPricingRuntimeConfig = z.infer<typeof LlmPricingConfigSchema>;

export function calculateDisplayPrice(usdPerToken: number, pricing: DisplayPricingConfig): number {
  if (
    !Number.isFinite(usdPerToken) ||
    usdPerToken < 0 ||
    !Number.isFinite(pricing.exchangeRate) ||
    pricing.exchangeRate <= 0 ||
    !Number.isFinite(pricing.markup) ||
    pricing.markup < 0
  ) {
    throw new Error('invalid OpenRouter display price inputs');
  }

  if (pricing.markup === 0) return 0;
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
