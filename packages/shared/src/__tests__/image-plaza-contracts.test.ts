import { describe, expect, it } from 'vitest';
import {
  IMAGE_PLAZA_PROMPT_MAX_CHARS,
  ImagePlazaFeedQuerySchema,
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaSnapshotSchema,
  ImagePlazaTagConfigSchema,
  SubmitImagePlazaAttemptRequestSchema,
} from '../api/image-plaza.js';

describe('image plaza feed query compatibility', () => {
  it('preserves omitted legacy sort and normalizes explicit sorts', () => {
    expect(ImagePlazaFeedQuerySchema.parse({})).toEqual({});
    expect(
      ImagePlazaFeedQuerySchema.parse({ sort: 'recommended', search: '  portrait  ' })
    ).toEqual({ sort: 'recommended', search: 'portrait' });
    expect(ImagePlazaFeedQuerySchema.parse({ sort: 'latest' }).sort).toBe('latest');
  });
  it.each([
    { sort: 'heat' },
    { cursor: '' },
    { cursor: 'x'.repeat(2049) },
    { search: 'x'.repeat(81) },
    { tag: ['all'] },
  ])('rejects invalid query %j', (input) => {
    expect(ImagePlazaFeedQuerySchema.safeParse(input).success).toBe(false);
  });
});

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
  it('preserves optional standard prices across JSON round trips without changing models', () => {
    const legacy = { default_model_id: 'seedream-v5-pro', models: [model()] };
    const parsedLegacy = ImagePlazaModelCatalogSchema.parse(legacy);
    expect(parsedLegacy.standard_prices).toBeUndefined();
    const prices = { '["seedream-v5-pro","1K"]': 0.11, '["seedream-v5-pro","2K"]': null };
    const saved = ImagePlazaModelCatalogSchema.parse({ ...legacy, standard_prices: prices });
    const loaded = ImagePlazaModelCatalogSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(loaded.standard_prices).toEqual(prices);
    expect(loaded.models).toEqual(parsedLegacy.models);
    expect(loaded.models[0]).not.toHaveProperty('standard_prices');
  });

  it.each([0, -1, Infinity, NaN, 1_000_001, 0.00001, '0.11'])(
    'rejects invalid standard price %s',
    (price) => {
      expect(
        ImagePlazaModelCatalogSchema.safeParse({
          default_model_id: 'seedream-v5-pro',
          models: [model()],
          standard_prices: { '["seedream-v5-pro","1K"]': price },
        }).success
      ).toBe(false);
    }
  );

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

describe('image plaza prompt limit', () => {
  const prompt = 'a'.repeat(IMAGE_PLAZA_PROMPT_MAX_CHARS);
  const snapshot = {
    prompt,
    model_id: 'seedream-v5-pro',
    aspect_ratio: '2:3',
    resolution: '1K',
    reasoning: false,
    auto_optimize: false,
    mode: 't2i',
    reference_artifact_id: null,
    style: 'None',
  };

  it('accepts 2000 characters across snapshots and attempt submissions', () => {
    expect(IMAGE_PLAZA_PROMPT_MAX_CHARS).toBe(2_000);
    expect(ImagePlazaSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      SubmitImagePlazaAttemptRequestSchema.safeParse({
        ...snapshot,
        quote_id: '11111111-1111-4111-8111-111111111111',
        idempotency_key: '22222222-2222-4222-8222-222222222222',
      }).success
    ).toBe(true);
  });

  it('accepts optional prompt_zh within the same length limit', () => {
    expect(
      ImagePlazaSnapshotSchema.safeParse({ ...snapshot, prompt_zh: '中文提示词' }).success
    ).toBe(true);
    expect(
      ImagePlazaSnapshotSchema.safeParse({
        ...snapshot,
        prompt_zh: '中'.repeat(IMAGE_PLAZA_PROMPT_MAX_CHARS + 1),
      }).success
    ).toBe(false);
  });

  it('rejects 2001 characters across snapshots and attempt submissions', () => {
    const overLimit = `${prompt}a`;
    expect(ImagePlazaSnapshotSchema.safeParse({ ...snapshot, prompt: overLimit }).success).toBe(
      false
    );
    expect(
      SubmitImagePlazaAttemptRequestSchema.safeParse({
        ...snapshot,
        prompt: overLimit,
        quote_id: '11111111-1111-4111-8111-111111111111',
        idempotency_key: '22222222-2222-4222-8222-222222222222',
      }).success
    ).toBe(false);
  });
});
