/**
 * backend / platform / model-tiers.ts
 *
 * 模型目录（runtime_config.llm_model_catalog）的唯一读取与缓存入口。
 *
 * 只有两个状态：catalog 有效 → 用它；缺失或损坏 → 用内置兜底目录 DEFAULT_CATALOG
 * 并打 error 日志。040 之前的旧 tiers key 已不再读取（两库该行都是 040 后的僵尸行，
 * 2026-09-11 确认后删掉回退分支；legacy guard 拦复活）。provider 固定为 openrouter（R3 决议）。
 */

import { fetchRuntimeConfigEntry, type RuntimeConfigEntry } from './runtime-config.js';
import {
  ModelCatalogSchema,
  LlmPricingConfigSchema,
  type LlmPricingRuntimeConfig,
  type ModelCatalog,
  type ModelCatalogTier,
  type ModelCatalogTierKey,
} from '@miniapp/shared';

let cachedCatalog: ModelCatalog | null = null;
let cachedCatalogVersion = 0;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * 内置兜底目录：runtime_config 读不到有效 catalog 时的最后一道防线。
 * 形状与删除回退分支前「旧 tiers → catalog 转换」对内置两模型的产物逐字段相同
 * （已对拍），这样故障态下用户看到的模型列表不因这次重构而变。
 */
export const DEFAULT_CATALOG: ModelCatalog = ModelCatalogSchema.parse({
  default_model_id: 'google-gemini-3.1-flash-lite',
  tiers: [
    {
      tier: 'standard',
      label: 'Standard',
      color: '#808080',
      cost_hint: '兼容历史配置',
      sort_order: 0,
      models: [
        {
          id: 'google-gemini-3.1-flash-lite',
          openrouter_model_id: 'google/gemini-3.1-flash-lite',
          display_name: 'gemini模型',
          tagline: '经典模型',
          is_free: false,
          enabled: true,
          sort_order: 0,
        },
        {
          id: 'anthropic-claude-sonnet-4.5',
          openrouter_model_id: 'anthropic/claude-sonnet-4.5',
          display_name: 'claude模型',
          tagline: '经典模型',
          is_free: false,
          enabled: true,
          sort_order: 1,
        },
      ],
    },
  ],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  } catch (err) {
    console.error('[model-tiers] Error refreshing model config:', err);
  }

  if (!cachedCatalog) {
    cachedCatalog = DEFAULT_CATALOG;
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
    catalog: cachedCatalog ?? DEFAULT_CATALOG,
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
