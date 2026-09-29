/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-04 10:01:59
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-29 16:42:39
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from '@miniapp/shared';
import { configMetadata } from './configSchemas';
import { getModelCatalogChangeSummary } from './modelCatalogDiff';

describe('getModelCatalogChangeSummary', () => {
  it('describes model-facing changes instead of raw JSON paths', () => {
    const before = structuredClone(configMetadata.llm_model_catalog.defaultValue) as ModelCatalog;
    const after = structuredClone(before);
    after.tiers[0]!.models[0]!.enabled = false;
    after.tiers[0]!.models[0]!.is_free = true;
    after.tiers[0]!.models.push({
      id: 'new-model',
      provider: 'openrouter',
      provider_model_id: 'vendor/new-model',
      openrouter_model_id: 'vendor/new-model',
      display_name: 'New Model',
      tagline: '全新体验',
      is_free: false,
      enabled: true,
      sort_order: 1,
    });
    after.default_model_id = 'new-model';

    expect(getModelCatalogChangeSummary(before, after)).toContain('下架“Gemini Flash Lite”');
    expect(getModelCatalogChangeSummary(before, after)).toContain(
      '将“Gemini Flash Lite”改为免费模型'
    );
    expect(getModelCatalogChangeSummary(before, after)).toContain('新增模型“New Model”');
    expect(getModelCatalogChangeSummary(before, after)).toContain('默认模型改为“New Model”');
  });
});
