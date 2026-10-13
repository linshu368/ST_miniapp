import { describe, expect, it } from 'vitest';
import {
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaTagConfigSchema,
} from '../api/image-plaza.js';

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seedream-v5-pro',
    provider_model_id: 'seedream-v5-pro',
    edit_provider_model_id: 'qwen-edit',
    sizing_mode: 'resolution',
    name: 'Seedream V5 Pro',
    description: '通用创作模型',
    supports_i2i: true,
    supports_edit: true,
    aspect_ratios: ['1:1'],
    resolutions: [{ id: '1K', label: '1K', credits: 60 }],
    enabled: true,
    sort_order: 0,
    internal_tags: [],
    ...overrides,
  };
}

describe('ImagePlazaModelCatalogSchema', () => {
  it('requires an edit provider mapping for edit-capable models', () => {
    const result = ImagePlazaModelCatalogSchema.safeParse({
      default_model_id: 'seedream-v5-pro',
      models: [model({ edit_provider_model_id: null })],
    });
    expect(result.success).toBe(false);
  });

  it('requires edit-capable models to support reference images', () => {
    const result = ImagePlazaModelCatalogSchema.safeParse({
      default_model_id: 'seedream-v5-pro',
      models: [model({ supports_i2i: false })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects fixed pricing tiers for resolution-sized models', () => {
    const result = ImagePlazaModelCatalogSchema.safeParse({
      default_model_id: 'seedream-v5-pro',
      models: [model({ resolutions: [{ id: 'fixed', label: '固定', credits: 60 }] })],
    });
    expect(result.success).toBe(false);
  });
});

describe('image plaza managed config schemas', () => {
  it('allows only the documented share-tip placeholders', () => {
    const base = {
      enabled: true,
      title: '返还 {rate}',
      description: '{model} 作品',
      reference_note: '',
      button_label: '分享',
    };
    expect(ImagePlazaShareTipConfigSchema.safeParse(base).success).toBe(true);
    expect(
      ImagePlazaShareTipConfigSchema.safeParse({ ...base, description: '用户 {name}' }).success
    ).toBe(false);
  });

  it('reserves the all tag and rejects duplicate IDs', () => {
    expect(
      ImagePlazaTagConfigSchema.safeParse([
        { id: 'all', label: '全部', enabled: true, sort_order: 0 },
      ]).success
    ).toBe(false);
    expect(
      ImagePlazaTagConfigSchema.safeParse([
        { id: 'portrait', label: '人像', enabled: true, sort_order: 0 },
        { id: 'portrait', label: '肖像', enabled: true, sort_order: 1 },
      ]).success
    ).toBe(false);
  });
});
