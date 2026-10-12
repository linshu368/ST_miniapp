import {
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaTagConfigSchema,
  type ImagePlazaModelCatalog,
  type ImagePlazaShareTipConfig,
  type ImagePlazaTagConfig,
} from '@miniapp/shared';
import { z } from 'zod';
import { fetchRuntimeConfigEntries } from '../../platform/runtime-config.js';

const CONFIG_KEYS = [
  'image_plaza_enabled',
  'image_plaza_model_catalog',
  'image_plaza_share_tip',
  'image_plaza_tags',
  'image_plaza_share_rebate_rate',
] as const;

const RebateRateSchema = z.number().min(0).max(1);

export interface ImagePlazaRuntimeConfig {
  enabled: boolean;
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
  const catalogEntry = entries.get('image_plaza_model_catalog');
  const catalog = ImagePlazaModelCatalogSchema.safeParse(catalogEntry?.value);
  const shareTip = ImagePlazaShareTipConfigSchema.safeParse(
    entries.get('image_plaza_share_tip')?.value
  );
  const tags = ImagePlazaTagConfigSchema.safeParse(entries.get('image_plaza_tags')?.value);
  const rebateRate = RebateRateSchema.safeParse(
    entries.get('image_plaza_share_rebate_rate')?.value
  );

  if (!catalog.success || !shareTip.success || !tags.success || !rebateRate.success) {
    throw new Error('image_plaza_runtime_config_invalid');
  }
  return {
    enabled,
    catalog: catalog.data,
    catalogVersion: catalogEntry?.version ?? 0,
    shareTip: shareTip.data,
    tags: tags.data,
    rebateRate: rebateRate.data,
  };
}
