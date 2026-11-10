import { z } from 'zod';
import { ProviderSlugSchema } from './provider-routing.js';
import { LlmModelProviderSchema, type LlmModelProvider } from './model-providers.js';
import { VipEntitlementSummarySchema } from './vip.js';
import { WalletDebitPolicySchema } from './wallet.js';

/** Delay after primary dispatch before starting the fallback; primary remains eligible. */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 4_000;
export const DEFAULT_FIRST_TOKEN_DEADLINE_MS = 6_000;
/** Legacy name: reserve before the shared deadline for launching fallback, not its lifetime. */
export const DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS = 2_000;
export const DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET = 0.01;
export const FIRST_TOKEN_FALLBACK_MODEL_ID = 'deepseek/deepseek-v4.1-flash-1017';
export const FallbackProviderRoutesSchema = z
  .array(
    z.object({
      model_id: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .regex(/^[^\s/]+\/[^\s/]+$/),
      preferred_providers: z
        .tuple([ProviderSlugSchema, ProviderSlugSchema])
        .refine(
          ([first, second]) => first.toLowerCase() !== second.toLowerCase(),
          '请选择两个不同的优先供应商'
        ),
    })
  )
  .max(100)
  .refine(
    (routes) => new Set(routes.map((route) => route.model_id.toLowerCase())).size === routes.length,
    '同一兜底型号只能配置一组优先供应商'
  );

/** Legacy 1017 has an explicit compatibility policy; never reuse it for another model. */
export function resolveFallbackProviders(
  catalog: Pick<ModelCatalog, 'fallback_model_id' | 'fallback_provider_routes'>
): [string, string] | undefined {
  const modelId = catalog.fallback_model_id ?? FIRST_TOKEN_FALLBACK_MODEL_ID;
  const route = catalog.fallback_provider_routes?.find(
    (item) => item.model_id.toLowerCase() === modelId.toLowerCase()
  );
  return route
    ? [...route.preferred_providers]
    : modelId === FIRST_TOKEN_FALLBACK_MODEL_ID
      ? ['together', 'crusoe']
      : undefined;
}
export const FIRST_TOKEN_RETRY_MESSAGE = '这次回应稍慢，再试一次吧';
const FirstTokenDurationSchema = z.number().int().positive().max(110_000);

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

/** Map leftover catalog markup fields to is_free before schema validation. */
export function normalizeCatalogModelInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const provider =
    typeof record.provider === 'string' && LlmModelProviderSchema.safeParse(record.provider).success
      ? record.provider
      : 'openrouter';
  const legacyOpenRouterId =
    typeof record.openrouter_model_id === 'string' ? record.openrouter_model_id.trim() : '';
  const providerModelId =
    typeof record.provider_model_id === 'string' && record.provider_model_id.trim()
      ? record.provider_model_id.trim()
      : legacyOpenRouterId;
  const normalizedProviderFields: Record<string, unknown> = {
    ...record,
    provider,
    provider_model_id: providerModelId,
    openrouter_model_id: legacyOpenRouterId || providerModelId,
  };
  if (typeof record.is_free === 'boolean') {
    const { markup: _markup, deduct_markup: _deductMarkup, ...rest } = normalizedProviderFields;
    return rest;
  }
  if (typeof record.markup === 'number') {
    const { markup, deduct_markup: _deductMarkup, ...rest } = normalizedProviderFields;
    return { ...rest, is_free: markup === 0 };
  }
  return normalizedProviderFields;
}

export const ModelCatalogModelSchema = z.object({
  /** Stable application-facing identifier. */
  id: StableModelIdSchema,
  /** Model platform that owns provider_model_id. Legacy configs default to OpenRouter. */
  provider: LlmModelProviderSchema.default('openrouter'),
  /** Provider-facing model identifier passed to the selected model platform. */
  provider_model_id: z.string().trim().min(1).max(200),
  /** Legacy compatibility field. For new code prefer provider + provider_model_id. */
  openrouter_model_id: z.string().trim().min(1).max(200),
  display_name: z.string().trim().min(1).max(40),
  /** 介绍语：说明模型适用场景的短句，展示在模型名称下方。 */
  tagline: z.string().trim().min(1).max(40),
  /** Whether this model receives the per-character free chat quota. */
  is_free: z.boolean(),
  /** Starts fallback after this primary dispatch delay; does not cancel the primary attempt. */
  first_token_timeout_ms: FirstTokenDurationSchema.default(DEFAULT_FIRST_TOKEN_TIMEOUT_MS),
  enabled: z.boolean(),
  sort_order: z.number().int().nonnegative(),
});

export const ModelCatalogTierSchema = z.object({
  tier: ModelCatalogTierKeySchema,
  label: z.string().trim().min(1).max(20),
  color: HexColorSchema,
  cost_hint: z.string().trim().min(1).max(50),
  sort_order: z.number().int().nonnegative(),
  models: z.array(z.preprocess(normalizeCatalogModelInput, ModelCatalogModelSchema)).min(1),
});

export const ModelCatalogSchema = z
  .object({
    default_model_id: z.string().trim().min(1),
    fallback_provider_routes: FallbackProviderRoutesSchema.optional(),
    fallback_model_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/,
        '请输入有效的 OpenRouter 模型 ID'
      )
      .default(FIRST_TOKEN_FALLBACK_MODEL_ID),
    /** Launch reserve when preparation consumes the total budget; both attempts share the deadline. */
    fallback_timeout_ms: FirstTokenDurationSchema.default(DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS),
    first_token_deadline_ms: FirstTokenDurationSchema.default(DEFAULT_FIRST_TOKEN_DEADLINE_MS),
    first_token_timeout_rate_target: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET),
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

    if (catalog.fallback_timeout_ms >= catalog.first_token_deadline_ms)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fallback_timeout_ms'],
        message: '兜底预留时间必须短于总等待上限',
      });
    const models = catalog.tiers.flatMap((tier) => tier.models);
    for (const [tierIndex, tier] of catalog.tiers.entries()) {
      for (const [modelIndex, model] of tier.models.entries()) {
        if (model.first_token_timeout_ms >= catalog.first_token_deadline_ms)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tiers', tierIndex, 'models', modelIndex, 'first_token_timeout_ms'],
            message: '启动兜底阈值必须短于总等待上限',
          });
      }
    }
    const modelIds = models.map((model) => model.id);
    const uniqueModelIds = new Set(modelIds);

    if (uniqueModelIds.size !== modelIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'model ids must be unique',
      });
    }

    const providerModelIds = models.map((model) => `${model.provider}:${model.provider_model_id}`);
    if (new Set(providerModelIds).size !== providerModelIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'provider model mappings must be unique',
      });
    }

    const openRouterModels = models.filter((model) => model.provider === 'openrouter');
    if (
      openRouterModels.some(
        (model) =>
          !/^[^\s/]+\/[^\s/]+$/.test(model.provider_model_id) ||
          model.openrouter_model_id !== model.provider_model_id
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message:
          'OpenRouter models must use provider_model_id vendor/model and mirror openrouter_model_id',
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
// Additive fields stay optional at typed legacy call sites; parsing always supplies defaults.
export type ModelCatalogModel = Omit<
  z.infer<typeof ModelCatalogModelSchema>,
  'first_token_timeout_ms'
> & {
  first_token_timeout_ms?: number;
};
export type ModelCatalogTier = Omit<z.infer<typeof ModelCatalogTierSchema>, 'models'> & {
  models: ModelCatalogModel[];
};
export type ModelCatalog = Omit<
  z.infer<typeof ModelCatalogSchema>,
  | 'tiers'
  | 'first_token_deadline_ms'
  | 'first_token_timeout_rate_target'
  | 'fallback_model_id'
  | 'fallback_timeout_ms'
> & {
  tiers: ModelCatalogTier[];
  fallback_model_id?: string;
  fallback_timeout_ms?: number;
  first_token_deadline_ms?: number;
  first_token_timeout_rate_target?: number;
};

export const PublicModelCatalogModelSchema = ModelCatalogModelSchema.omit({
  first_token_timeout_ms: true,
  provider: true,
  provider_model_id: true,
  openrouter_model_id: true,
  enabled: true,
});

export const PublicModelCatalogTierSchema = z.object({
  key: ModelCatalogTierKeySchema,
  label: z.string().trim().min(1),
  color: z.string().trim().min(1),
  cost_hint: z.string(),
  sort_order: z.number().finite(),
  models: z.array(PublicModelCatalogModelSchema),
  requires_vip: z.boolean().optional(),
  locked: z.boolean().optional(),
  original_credits: z.number().finite().nonnegative().optional(),
  discount_rate: z.number().finite().nonnegative().nullable().optional(),
  discount_source: z.enum(['vip', 'creator']).nullable().optional(),
  discounted_exact: z.number().finite().nonnegative().nullable().optional(),
  payable_credits: z.number().int().nonnegative().optional(),
  wallet_policy: WalletDebitPolicySchema.optional(),
});

export const PublicModelCatalogSchema = z.object({
  first_token_deadline_ms: FirstTokenDurationSchema.optional(),
  default_model_id: z.string().trim().min(1),
  tiers: z.array(PublicModelCatalogTierSchema),
});

export const GetModelCatalogDataSchema = z.object({
  catalog: PublicModelCatalogSchema,
  selected_model_id: z.string().trim().min(1),
  selected_openrouter_model_id: z.string().trim().min(1),
  selected_provider: LlmModelProviderSchema.optional(),
  selected_provider_model_id: z.string().trim().min(1).optional(),
  catalog_version: z.number().int().nonnegative(),
  vip_status: VipEntitlementSummarySchema.optional(),
});

export const SelectModelRequestSchema = z.object({
  model_id: z.string().trim().min(1),
  character_id: z.string().uuid().optional(),
});

export const GetModelCatalogQuerySchema = z.object({
  character_id: z.string().uuid().optional(),
});

export const SelectModelDataSchema = z.object({
  model_id: z.string().trim().min(1),
  openrouter_model_id: z.string().trim().min(1),
  provider: LlmModelProviderSchema.optional(),
  provider_model_id: z.string().trim().min(1).optional(),
});

export type PublicModelCatalogModel = z.infer<typeof PublicModelCatalogModelSchema>;
export type PublicModelCatalogTier = z.infer<typeof PublicModelCatalogTierSchema>;
export type PublicModelCatalog = z.infer<typeof PublicModelCatalogSchema>;
export type GetModelCatalogData = z.infer<typeof GetModelCatalogDataSchema>;
export type SelectModelRequest = z.infer<typeof SelectModelRequestSchema>;
export type SelectModelData = z.infer<typeof SelectModelDataSchema>;

const RuntimeCatalogModelSchema = z.object({
  id: z.string().trim().min(1),
  provider: LlmModelProviderSchema.optional().default('openrouter'),
  provider_model_id: z.string().trim().min(1).optional(),
  openrouter_model_id: z.string().trim().min(1).optional(),
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
  provider: LlmModelProvider;
  provider_model_id: string;
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
  if (!model) return null;
  const providerModelId = model.provider_model_id ?? model.openrouter_model_id ?? '';
  if (!providerModelId) return null;
  return {
    id: model.id,
    provider: model.provider,
    provider_model_id: providerModelId,
    openrouter_model_id: model.openrouter_model_id ?? providerModelId,
  };
}

export function toPublicModelCatalog(catalog: ModelCatalog): PublicModelCatalog {
  return PublicModelCatalogSchema.parse({
    first_token_deadline_ms: catalog.first_token_deadline_ms ?? DEFAULT_FIRST_TOKEN_DEADLINE_MS,
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
          .map(({ openrouter_model_id: _openrouterModelId, enabled: _enabled, ...model }) => model),
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
