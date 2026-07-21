/**
 * backend / platform / model-tiers.ts
 *
 * Published model catalog and legacy model-tier compatibility.
 *
 * Reads llm_model_catalog first and falls back to llm_model_tiers.
 * provider 固定为 openrouter（R3 决议）。
 */

import { getSupabaseClient } from '../lib/supabase.js';
import {
  ModelCatalogModelSchema,
  ModelCatalogSchema,
  resolveEnabledCatalogModel,
  type ModelCatalog,
  type ModelCatalogTier,
  type ModelTierConfig as SharedModelTierConfig,
} from '@miniapp/shared';

// 扩展 SharedModelTierConfig 以包含后端需要的字段
export interface BackendModelTierConfig extends SharedModelTierConfig {
  // 后端内部使用的字段可以加在这里
}

let cachedTiers: BackendModelTierConfig[] | null = null;
let cachedCatalog: ModelCatalog | null = null;
let cachedCatalogVersion = 0;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const LEGACY_MODEL_TAGLINE = ModelCatalogModelSchema.shape.tagline.parse('经典模型');

const DEFAULT_TIERS: BackendModelTierConfig[] = [
  {
    tier: 'modelA',
    modelName: 'google/gemini-3.1-flash-lite',
    provider: 'openrouter',
    label: 'gemini模型',
    deductionRate: 0,
    isDefault: true,
  },
  {
    tier: 'modelB',
    modelName: 'anthropic/claude-sonnet-4.5',
    provider: 'openrouter',
    label: 'claude模型',
    deductionRate: 0,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLegacyTiers(value: unknown): BackendModelTierConfig[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const tiers: BackendModelTierConfig[] = [];
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

function catalogToLegacyTiers(catalog: ModelCatalog): BackendModelTierConfig[] {
  return catalog.tiers.flatMap((tier) =>
    tier.models.map((model) => ({
      // A catalog tier may contain multiple models, so the stable model id is
      // also the unique legacy switcher key.
      tier: model.id,
      modelName: model.openrouter_model_id,
      provider: OPENROUTER_PROVIDER,
      label: model.display_name,
      deductionRate: 0,
      ...(model.id === catalog.default_model_id ? { isDefault: true } : {}),
    }))
  );
}

export function legacyTiersToCatalog(tiers: BackendModelTierConfig[]): ModelCatalog {
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
        price_input: 0,
        price_output: 0,
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

async function fetchRuntimeConfigValue(key: string): Promise<unknown | null> {
  const db = getSupabaseClient().schema('miniapp');
  const { data, error } = await db
    .from('runtime_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error(`[model-tiers] Failed to fetch ${key} from runtime_config:`, error);
    return null;
  }

  return data?.value ?? null;
}

interface RuntimeConfigEntry {
  value: unknown;
  version: number;
}

async function fetchRuntimeConfigEntry(key: string): Promise<RuntimeConfigEntry | null> {
  const db = getSupabaseClient().schema('miniapp');
  const { data, error } = await db
    .from('runtime_config')
    .select('value,version')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error(`[model-tiers] Failed to fetch ${key} metadata:`, error);
    return null;
  }
  if (!data) return null;
  return {
    value: data.value,
    version: typeof data.version === 'number' ? data.version : 0,
  };
}

async function refreshModelConfig(catalogEntry?: RuntimeConfigEntry | null): Promise<void> {
  const now = Date.now();

  try {
    const entry = catalogEntry ?? (await fetchRuntimeConfigEntry('llm_model_catalog'));
    const catalog = normalizeCatalog(entry?.value ?? null);
    if (catalog) {
      cachedCatalog = catalog;
      cachedTiers = catalogToLegacyTiers(catalog);
      cachedCatalogVersion = entry?.version ?? 0;
      lastFetchTime = now;
      return;
    }

    const legacyTiers = parseLegacyTiers(await fetchRuntimeConfigValue('llm_model_tiers'));
    if (legacyTiers) {
      cachedTiers = legacyTiers;
      cachedCatalog = legacyTiersToCatalog(legacyTiers);
      cachedCatalogVersion = 0;
      lastFetchTime = now;
      return;
    }
  } catch (err) {
    console.error('[model-tiers] Error refreshing model config:', err);
  }

  if (!cachedTiers || !cachedCatalog) {
    cachedTiers = DEFAULT_TIERS;
    cachedCatalog = legacyTiersToCatalog(DEFAULT_TIERS);
    cachedCatalogVersion = 0;
    lastFetchTime = now;
  }
}

async function ensureModelConfig(): Promise<void> {
  const catalogEntry = await fetchRuntimeConfigEntry('llm_model_catalog');
  if (
    cachedTiers &&
    cachedCatalog &&
    catalogEntry &&
    shouldReuseCatalogCache(cachedCatalogVersion, catalogEntry.version)
  ) {
    return;
  }
  if (cachedTiers && cachedCatalog && !catalogEntry && Date.now() - lastFetchTime < CACHE_TTL_MS) {
    return;
  }
  await refreshModelConfig(catalogEntry);
}

export function shouldReuseCatalogCache(cachedVersion: number, runtimeVersion: number): boolean {
  return cachedVersion === runtimeVersion;
}

export function invalidateModelConfigCache(): void {
  cachedTiers = null;
  cachedCatalog = null;
  cachedCatalogVersion = 0;
  lastFetchTime = 0;
}

/** Backwards-compatible cache helper name for existing integrations. */
export const invalidateModelTiersCache = invalidateModelConfigCache;

export async function fetchModelCatalog(): Promise<ModelCatalog> {
  await ensureModelConfig();
  return cachedCatalog ?? legacyTiersToCatalog(DEFAULT_TIERS);
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

export async function fetchModelTiers(): Promise<BackendModelTierConfig[]> {
  await ensureModelConfig();
  return cachedTiers ?? DEFAULT_TIERS;
}

export async function resolveOpenRouterModelId(stableModelId: string): Promise<string> {
  const catalog = await fetchModelCatalog();
  return resolveEnabledCatalogModel(catalog, stableModelId).openrouter_model_id;
}

export async function resolveDefaultOpenRouterModelId(): Promise<string> {
  const catalog = await fetchModelCatalog();
  return resolveEnabledCatalogModel(catalog, catalog.default_model_id).openrouter_model_id;
}

export async function getModelMarkup(
  openRouterModelId: string,
  fallbackMarkup?: number
): Promise<number> {
  const fallback = fallbackMarkup ?? (await getPricingConfig()).markup;
  try {
    const catalog = await fetchModelCatalog();
    const model = catalog.tiers
      .flatMap((tier) => tier.models)
      .find((candidate) => candidate.openrouter_model_id === openRouterModelId);
    return model?.markup ?? fallback;
  } catch (error) {
    console.error('[model-tiers] Failed to resolve per-model markup:', error);
    return fallback;
  }
}

export interface ModelBillingContext {
  modelId: string | null;
  modelDisplayName: string;
  openRouterModelId: string;
  catalogVersion: number;
  modelMarkup: number;
}

export async function getModelBillingContext(
  openRouterModelId: string,
  fallbackMarkup?: number
): Promise<ModelBillingContext> {
  const [snapshot, pricing] = await Promise.all([
    fetchModelCatalogSnapshot(),
    fallbackMarkup === undefined ? getPricingConfig() : Promise.resolve(null),
  ]);
  const fallback = fallbackMarkup ?? pricing?.markup ?? DEFAULT_PRICING.markup;
  const model = snapshot.catalog.tiers
    .flatMap((tier) => tier.models)
    .find((candidate) => candidate.openrouter_model_id === openRouterModelId);

  return {
    modelId: model?.id ?? null,
    modelDisplayName: model?.display_name ?? (openRouterModelId || 'Unknown Model'),
    openRouterModelId,
    catalogVersion: snapshot.version,
    modelMarkup: model?.markup ?? fallback,
  };
}

export async function getModelTier(modelName: string): Promise<BackendModelTierConfig> {
  const tiers = await fetchModelTiers();
  const found = tiers.find((t) => t.modelName === modelName);
  if (found) return found;

  return {
    tier: 'unknown',
    modelName,
    provider: 'openrouter',
    label: 'Unknown Model',
    deductionRate: 0,
  };
}

export async function getAllTiers(): Promise<BackendModelTierConfig[]> {
  return fetchModelTiers();
}

export const OPENROUTER_PROVIDER = 'openrouter';

export interface LlmPricingConfig {
  version: number;
  balanceBaseline: number;
  fallbackCost: number;
  exchangeRate: number;
  markup: number;
}

const DEFAULT_PRICING: LlmPricingConfig = {
  version: 0,
  balanceBaseline: 30,
  fallbackCost: 30,
  exchangeRate: 680,
  markup: 2.5,
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
      cachedPricing = {
        ...DEFAULT_PRICING,
        ...(entry.value as Partial<LlmPricingConfig>),
        version: entry.version,
      };
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
