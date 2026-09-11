/**
 * backend / platform / model-tiers.ts
 *
 * 模型目录（runtime_config.llm_model_catalog）的唯一读取与缓存入口。
 *
 * 读 llm_model_catalog；缺失或损坏时回退到旧 key llm_model_tiers（040 之前的形状），
 * 两者都没有时用内置兜底目录。provider 固定为 openrouter（R3 决议）。
 */

import {
  fetchRuntimeConfigEntry,
  fetchRuntimeConfigValue,
  type RuntimeConfigEntry,
} from './runtime-config.js';
import {
  ModelCatalogModelSchema,
  ModelCatalogSchema,
  LlmPricingConfigSchema,
  type LlmPricingRuntimeConfig,
  type ModelCatalog,
  type ModelCatalogTier,
  type ModelCatalogTierKey,
} from '@miniapp/shared';

/** 040 之前 runtime_config.llm_model_tiers 的行形状，只在回退分支里解析。 */
export interface LegacyModelTier {
  tier: string;
  modelName: string;
  provider: string;
  label: string;
  deductionRate: number;
  isDefault?: boolean;
}

let cachedCatalog: ModelCatalog | null = null;
let cachedCatalogVersion = 0;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OPENROUTER_PROVIDER = 'openrouter';
export const LEGACY_MODEL_TAGLINE = ModelCatalogModelSchema.shape.tagline.parse('经典模型');

const DEFAULT_TIERS: LegacyModelTier[] = [
  {
    tier: 'modelA',
    modelName: 'google/gemini-3.1-flash-lite',
    provider: OPENROUTER_PROVIDER,
    label: 'gemini模型',
    deductionRate: 0,
    isDefault: true,
  },
  {
    tier: 'modelB',
    modelName: 'anthropic/claude-sonnet-4.5',
    provider: OPENROUTER_PROVIDER,
    label: 'claude模型',
    deductionRate: 0,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLegacyTiers(value: unknown): LegacyModelTier[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const tiers: LegacyModelTier[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.tier !== 'string' ||
      item.tier.trim().length === 0 ||
      typeof item.modelName !== 'string' ||
      item.modelName.trim().length === 0 ||
      typeof item.label !== 'string' ||
      item.label.trim().length === 0 ||
      typeof item.deductionRate !== 'number' ||
      !Number.isFinite(item.deductionRate) ||
      item.deductionRate < 0 ||
      (item.isDefault !== undefined && typeof item.isDefault !== 'boolean')
    ) {
      return null;
    }

    tiers.push({
      tier: item.tier,
      modelName: item.modelName,
      provider: OPENROUTER_PROVIDER,
      label: item.label,
      deductionRate: item.deductionRate,
      ...(item.isDefault === undefined ? {} : { isDefault: item.isDefault }),
    });
  }

  return tiers;
}

function normalizeCatalog(value: unknown): ModelCatalog | null {
  const parsed = ModelCatalogSchema.safeParse(value);
  if (!parsed.success) {
    console.error('[model-tiers] Invalid llm_model_catalog:', parsed.error.flatten());
    return null;
  }

  const tiers = parsed.data.tiers
    .map<ModelCatalogTier>((tier) => ({
      ...tier,
      models: tier.models
        .filter((model) => model.enabled)
        .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)),
    }))
    .filter((tier) => tier.models.length > 0)
    .sort((a, b) => a.sort_order - b.sort_order || a.tier.localeCompare(b.tier));

  const normalized = {
    default_model_id: parsed.data.default_model_id,
    tiers,
  };

  // A disabled default would make the published, enabled-only response invalid.
  return ModelCatalogSchema.safeParse(normalized).success ? normalized : null;
}

export function legacyTiersToCatalog(tiers: LegacyModelTier[]): ModelCatalog {
  const usedStableIds = new Set<string>();
  const models = Array.from(new Map(tiers.map((tier) => [tier.modelName, tier])).values()).map(
    (tier, sortOrder) => {
      const baseId =
        tier.modelName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || `model-${sortOrder + 1}`;
      let stableId = baseId.slice(0, 64).replace(/[^a-z0-9]$/g, '');
      if (usedStableIds.has(stableId)) stableId = `${stableId.slice(0, 60)}-${sortOrder + 1}`;
      usedStableIds.add(stableId);
      return {
        id: stableId,
        openrouter_model_id: tier.modelName,
        display_name: tier.label.slice(0, 40),
        tagline: LEGACY_MODEL_TAGLINE,
        is_free: false,
        enabled: true,
        sort_order: sortOrder,
      };
    }
  );
  const defaultTier = tiers.find((tier) => tier.isDefault) ?? tiers[0];
  const defaultModelId =
    models.find((model) => model.openrouter_model_id === defaultTier?.modelName)?.id ??
    models[0]?.id;
  if (!defaultModelId) {
    throw new Error('Cannot build a model catalog from an empty legacy tier list');
  }

  return ModelCatalogSchema.parse({
    default_model_id: defaultModelId,
    tiers: [
      {
        tier: 'standard',
        label: 'Standard',
        color: '#808080',
        cost_hint: '兼容历史配置',
        sort_order: 0,
        models,
      },
    ],
  });
}

async function refreshModelConfig(catalogEntry?: RuntimeConfigEntry | null): Promise<void> {
  const now = Date.now();

  try {
    const entry = catalogEntry ?? (await fetchRuntimeConfigEntry('llm_model_catalog'));
    const catalog = normalizeCatalog(entry?.value ?? null);
    if (catalog) {
      cachedCatalog = catalog;
      cachedCatalogVersion = entry?.version ?? 0;
      lastFetchTime = now;
      return;
    }

    const legacyTiers = parseLegacyTiers(await fetchRuntimeConfigValue('llm_model_tiers'));
    if (legacyTiers) {
      cachedCatalog = legacyTiersToCatalog(legacyTiers);
      cachedCatalogVersion = 0;
      lastFetchTime = now;
      return;
    }
  } catch (err) {
    console.error('[model-tiers] Error refreshing model config:', err);
  }

  if (!cachedCatalog) {
    cachedCatalog = legacyTiersToCatalog(DEFAULT_TIERS);
    cachedCatalogVersion = 0;
    lastFetchTime = now;
  }
}

async function ensureModelConfig(): Promise<void> {
  const catalogEntry = await fetchRuntimeConfigEntry('llm_model_catalog');
  if (
    cachedCatalog &&
    catalogEntry &&
    shouldReuseCatalogCache(cachedCatalogVersion, catalogEntry.version)
  ) {
    return;
  }
  if (cachedCatalog && !catalogEntry && Date.now() - lastFetchTime < CACHE_TTL_MS) {
    return;
  }
  await refreshModelConfig(catalogEntry);
}

export function shouldReuseCatalogCache(cachedVersion: number, runtimeVersion: number): boolean {
  return cachedVersion === runtimeVersion;
}

export async function fetchModelCatalogSnapshot(): Promise<{
  catalog: ModelCatalog;
  version: number;
}> {
  await ensureModelConfig();
  return {
    catalog: cachedCatalog ?? legacyTiersToCatalog(DEFAULT_TIERS),
    version: cachedCatalogVersion,
  };
}

export interface ModelBillingContext {
  modelId: string | null;
  modelDisplayName: string;
  openRouterModelId: string;
  modelTier: ModelCatalogTierKey | null;
  catalogVersion: number;
  isFree: boolean;
}

export async function getModelBillingContext(
  openRouterModelId: string
): Promise<ModelBillingContext> {
  const snapshot = await fetchModelCatalogSnapshot();
  const catalogTier =
    snapshot.catalog.tiers.find((tier) =>
      tier.models.some((candidate) => candidate.openrouter_model_id === openRouterModelId)
    ) ?? null;
  const model =
    catalogTier?.models.find((candidate) => candidate.openrouter_model_id === openRouterModelId) ??
    null;

  return {
    modelId: model?.id ?? null,
    modelDisplayName: model?.display_name ?? (openRouterModelId || 'Unknown Model'),
    openRouterModelId,
    modelTier: catalogTier?.tier ?? null,
    catalogVersion: snapshot.version,
    isFree: model?.is_free ?? false,
  };
}

export interface LlmPricingConfig extends LlmPricingRuntimeConfig {
  version: number;
}

const DEFAULT_PRICING: LlmPricingConfig = {
  version: 0,
  fixedDeduction: {
    freeQuotaExhausted: 10,
    light: 15,
    standard: 30,
    premium: 50,
  },
};

let cachedPricing: LlmPricingConfig | null = null;
let lastPricingFetchTime = 0;

export async function getPricingConfig(): Promise<LlmPricingConfig> {
  const now = Date.now();

  try {
    const entry = await fetchRuntimeConfigEntry('llm_pricing_config');
    if (entry && cachedPricing?.version === entry.version) {
      return cachedPricing;
    }
    if (entry?.value && typeof entry.value === 'object') {
      const runtimePricing = entry.value as Partial<LlmPricingConfig>;
      const mergedPricing = {
        ...DEFAULT_PRICING,
        ...runtimePricing,
        fixedDeduction: {
          ...DEFAULT_PRICING.fixedDeduction,
          ...(isRecord(runtimePricing.fixedDeduction) ? runtimePricing.fixedDeduction : {}),
        },
      };
      const parsedPricing = LlmPricingConfigSchema.safeParse(mergedPricing);
      if (!parsedPricing.success) {
        console.error('[model-tiers] Invalid llm_pricing_config:', parsedPricing.error.flatten());
        return cachedPricing ?? DEFAULT_PRICING;
      }
      cachedPricing = { ...parsedPricing.data, version: entry.version };
      lastPricingFetchTime = now;
      return cachedPricing;
    }
    if (cachedPricing && now - lastPricingFetchTime < CACHE_TTL_MS) {
      return cachedPricing;
    }
  } catch (err) {
    console.error('[model-tiers] Error fetching llm_pricing_config:', err);
  }

  return cachedPricing || DEFAULT_PRICING;
}
