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
  /** 标签筛选展示 + 分享自动打标；仅显式 false 关闭，缺失视为开。 */
  tagsFeatureEnabled: boolean;
  catalog: ImagePlazaModelCatalog;
  catalogVersion: number;
  shareTip: ImagePlazaShareTipConfig;
  tags: ImagePlazaTagConfig;
  rebateRate: number;
}

/** 广场配置任一关键字段损坏都停止新受理，避免用未知模型或价格继续产生费用。 */
export async function getImagePlazaRuntimeConfig(): Promise<ImagePlazaRuntimeConfig> {
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

/** Feed/bootstrap 对外标签：功能关时仅「全部」。 */
export function publicImagePlazaFeedTags(
  runtime: Pick<ImagePlazaRuntimeConfig, 'tagsFeatureEnabled' | 'tags'>
): Array<{ id: string; label: string }> {
  const all = { id: 'all', label: '全部' };
  if (!runtime.tagsFeatureEnabled) return [all];
  return [
    all,
    ...runtime.tags
      .filter((tag) => tag.enabled)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(({ id, label }) => ({ id, label })),
  ];
}
