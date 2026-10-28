import {
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaTagConfigSchema,
  type ImagePlazaModelCatalog,
  type ImagePlazaShareTipConfig,
  type ImagePlazaTagConfig,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntries } from '../../platform/runtime-config.js';

const CONFIG_KEYS = [
  'image_plaza_enabled',
  'image_plaza_model_catalog',
  'image_plaza_share_tip',
  'image_plaza_tags',
  'image_plaza_share_rebate_rate',
  'image_plaza_tags_feature_enabled',
] as const;

export interface ImagePlazaRuntimeConfig {
  enabled: boolean;
  /** 仅控制分享自动打标；显式 false 关闭，缺失视为开。不控制 feed 标签展示或筛选。 */
  tagsFeatureEnabled: boolean;
  catalog: ImagePlazaModelCatalog;
  catalogVersion: number;
  shareTip: ImagePlazaShareTipConfig;
  tags: ImagePlazaTagConfig;
  rebateRate: number;
}

const CONFIG_CACHE_TTL_MS = 5_000;
let cachedConfig: { value: ImagePlazaRuntimeConfig; expiresAt: number } | null = null;
let configInflight: Promise<ImagePlazaRuntimeConfig> | null = null;

/** 广场配置任一关键字段损坏都停止新受理，避免用未知模型或价格继续产生费用。 */
export async function getImagePlazaRuntimeConfig(): Promise<ImagePlazaRuntimeConfig> {
  return loadImagePlazaRuntimeConfig();
}

/** Feed/display reads may briefly reuse config; quote and generation paths remain uncached. */
export async function getImagePlazaFeedRuntimeConfig(): Promise<ImagePlazaRuntimeConfig> {
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  if (configInflight) return configInflight;

  const operation = loadImagePlazaRuntimeConfig();
  configInflight = operation;
  try {
    const value = await operation;
    cachedConfig = { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
    return value;
  } finally {
    // Failed reads are deliberately not cached, so the next request may recover immediately.
    if (configInflight === operation) configInflight = null;
  }
}

async function loadImagePlazaRuntimeConfig(): Promise<ImagePlazaRuntimeConfig> {
  const entries = await fetchRuntimeConfigEntries(CONFIG_KEYS);
  const enabled = entries.get('image_plaza_enabled')?.value === true;
  const tagsFeatureEnabled = entries.get('image_plaza_tags_feature_enabled')?.value !== false;
  const catalogEntry = entries.get('image_plaza_model_catalog');
  const catalog = ImagePlazaModelCatalogSchema.safeParse(catalogEntry?.value);
  const shareTip = ImagePlazaShareTipConfigSchema.safeParse(
    entries.get('image_plaza_share_tip')?.value
  );
  const tags = ImagePlazaTagConfigSchema.safeParse(entries.get('image_plaza_tags')?.value);
  const rebateValue = entries.get('image_plaza_share_rebate_rate')?.value;
  const rebateRate =
    typeof rebateValue === 'number' &&
    Number.isFinite(rebateValue) &&
    rebateValue >= 0 &&
    rebateValue <= 1
      ? rebateValue
      : null;

  if (!catalog.success || !shareTip.success || !tags.success || rebateRate === null) {
    throw new Error('image_plaza_runtime_config_invalid');
  }
  return {
    enabled,
    tagsFeatureEnabled,
    catalog: catalog.data,
    catalogVersion: catalogEntry?.version ?? 0,
    shareTip: shareTip.data,
    tags: tags.data,
    rebateRate,
  };
}

/** Feed/bootstrap 对外标签：始终返回「全部」+ 启用且排序的目录，与自动打标开关无关。 */
export function publicImagePlazaFeedTags(
  runtime: Pick<ImagePlazaRuntimeConfig, 'tags'>
): Array<{ id: string; label: string }> {
  const all = { id: 'all', label: '全部' };
  return [
    all,
    ...runtime.tags
      .filter((tag) => tag.enabled)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(({ id, label }) => ({ id, label })),
  ];
}
