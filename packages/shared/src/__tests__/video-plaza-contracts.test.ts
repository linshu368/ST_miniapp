import { describe, expect, it } from 'vitest';
import {
  GetImagePlazaConfigDataSchema,
  ImagePlazaFeedQuerySchema,
  ImagePlazaTagConfigSchema,
} from '../api/image-plaza.js';
import {
  ProviderVideoPlazaModelSchema,
  SubmitVideoPlazaAttemptRequestSchema,
  VideoPlazaModelCatalogSchema,
  VideoPlazaSnapshotSchema,
} from '../api/video-plaza.js';

function videoModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wan-3-pro',
    name: 'Wan 3.0 Pro',
    description: '通用视频模型',
    image_input: 'optional_first_frame',
    durations: [5, 10],
    resolutions: ['1080p'],
    aspect_ratios: ['16:9', '9:16'],
    audio_configurable: true,
    default_audio: true,
    default_duration: 5,
    default_resolution: '1080p',
    default_aspect_ratio: '16:9',
    image_constraints: { min_short_side: 240 },
    provider_ids: {
      t2v: 'wan-3-0-pro-text-to-video',
      i2v: 'wan-3-0-pro-image-to-video',
    },
    enabled: true,
    sort_order: 0,
    price_matrix: {
      '5|1080p|0': 20,
      '5|1080p|1': 30,
      '10|1080p|0': 40,
      '10|1080p|1': 50,
    },
    seed_aliases: [],
    ...overrides,
  };
}

describe('video plaza model catalog', () => {
  it('accepts a complete provider mapping and exact price matrix', () => {
    const model = ProviderVideoPlazaModelSchema.parse(videoModel());
    expect(model.provider_ids.i2v).toBe('wan-3-0-pro-image-to-video');
    expect(
      VideoPlazaModelCatalogSchema.safeParse({ default_model_id: model.id, models: [model] })
        .success
    ).toBe(true);
  });

  it('rejects missing and unknown price combinations', () => {
    expect(
      ProviderVideoPlazaModelSchema.safeParse(videoModel({ price_matrix: { '5|1080p|1': 30 } }))
        .success
    ).toBe(false);
    expect(
      ProviderVideoPlazaModelSchema.safeParse(
        videoModel({
          price_matrix: {
            ...videoModel().price_matrix,
            '5|4k|1': 90,
          },
        })
      ).success
    ).toBe(false);
  });

  it('requires reference-only models to omit t2v and provide an image provider', () => {
    expect(
      ProviderVideoPlazaModelSchema.safeParse(
        videoModel({
          image_input: 'required_reference',
          provider_ids: { r2v: 'seedance-2-0-reference-to-video-basic' },
        })
      ).success
    ).toBe(true);
    expect(
      ProviderVideoPlazaModelSchema.safeParse(
        videoModel({ image_input: 'required_reference', provider_ids: { t2v: 'wrong' } })
      ).success
    ).toBe(false);
  });
});

describe('video plaza public requests', () => {
  it('does not impose the image prompt limit on video prompts', () => {
    const prompt = '长'.repeat(25_279);
    expect(
      SubmitVideoPlazaAttemptRequestSchema.safeParse({
        prompt,
        quote_id: '11111111-1111-4111-8111-111111111111',
        idempotency_key: '22222222-2222-4222-8222-222222222222',
      }).success
    ).toBe(true);
    expect(
      VideoPlazaSnapshotSchema.safeParse({
        prompt,
        model_id: 'wan-3-pro',
        input_mode: 't2v',
        duration_s: 5,
        resolution: '1080p',
        aspect_ratio: '16:9',
        audio: true,
        reference_artifact_id: null,
      }).success
    ).toBe(true);
  });

  it('strictly rejects image-only auto_optimize on video submission', () => {
    expect(
      SubmitVideoPlazaAttemptRequestSchema.safeParse({
        prompt: 'test',
        quote_id: '11111111-1111-4111-8111-111111111111',
        idempotency_key: '22222222-2222-4222-8222-222222222222',
        auto_optimize: true,
      }).success
    ).toBe(false);
  });
});

describe('image plaza compatibility extensions', () => {
  it('keeps legacy feed queries and accepts normalized media/tag filters', () => {
    expect(ImagePlazaFeedQuerySchema.parse({})).toEqual({});
    expect(
      ImagePlazaFeedQuerySchema.parse({ media: 'video', tags: ' portrait,cinematic ' })
    ).toEqual({ media: 'video', tags: 'portrait,cinematic' });
    expect(
      ImagePlazaFeedQuerySchema.safeParse({
        tags: Array.from({ length: 11 }, (_, i) => i).join(','),
      }).success
    ).toBe(false);
  });

  it('defaults old tag and config payloads to image-only with video disabled', () => {
    expect(
      ImagePlazaTagConfigSchema.parse([
        { id: 'portrait', label: '人像', enabled: true, sort_order: 0 },
      ])[0]?.media_types
    ).toEqual(['image']);

    const parsed = GetImagePlazaConfigDataSchema.parse({
      enabled: true,
      models: [],
      tags: [{ id: 'portrait', label: '人像' }],
      share_tip: {
        enabled: false,
        title: '分享',
        description: '分享',
        reference_note: '',
        button_label: '分享',
      },
      share_rebate_rate: 0,
      has_completed_first_share: false,
    });
    expect(parsed.video_models).toEqual([]);
    expect(parsed.default_video_model_id).toBeNull();
    expect(parsed.tags[0]?.media_types).toEqual(['image']);
  });
});
