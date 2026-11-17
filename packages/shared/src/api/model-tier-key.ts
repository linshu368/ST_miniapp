import { z } from 'zod';

/** 付费三档。单独成文件，免得模型目录和畅聊栏目两个契约互相 import。 */
export const ModelCatalogTierKeySchema = z.enum(['light', 'standard', 'premium']);
export type ModelCatalogTierKey = z.infer<typeof ModelCatalogTierKeySchema>;
