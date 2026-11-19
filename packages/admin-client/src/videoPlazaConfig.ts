import { selectSupportedVideoPlazaOptions, type VideoPlazaModelCatalog } from '@miniapp/shared';

const model = (
  input: {
    id: string;
    name: string;
    provider_ids: { t2v?: string; i2v?: string; r2v?: string };
    image_input: 'none' | 'optional_first_frame' | 'optional_reference' | 'required_reference';
    durations: number[];
    resolutions: string[];
    aspect_ratios: string[];
    audio_configurable: boolean;
    default_audio: boolean;
    min_short_side?: number;
    min_ratio?: number;
    max_ratio?: number;
    enabled?: boolean;
    seed_aliases?: string[];
  },
  sort_order: number
) => ({
  ...input,
  description: '发布前请核对 Venice 能力与真实报价',
  default_duration: input.durations[0],
  default_resolution: input.resolutions[0],
  default_aspect_ratio: input.aspect_ratios[0] ?? null,
  image_constraints: {
    ...(input.min_short_side ? { min_short_side: input.min_short_side } : {}),
    ...(input.min_ratio ? { min_ratio: input.min_ratio } : {}),
    ...(input.max_ratio ? { max_ratio: input.max_ratio } : {}),
  },
  enabled: input.enabled ?? false,
  sort_order,
  seed_aliases: input.seed_aliases ?? [],
  price_matrix: Object.fromEntries(
    input.durations.flatMap((duration) =>
      input.resolutions.flatMap((resolution) =>
        (input.audio_configurable ? [false, true] : [input.default_audio]).map((audio) => [
          `${duration}|${resolution}|${audio ? 1 : 0}`,
          1,
        ])
      )
    )
  ),
});

export function createDefaultVideoCatalog() {
  const supportedRatios = ['16:9', '9:16', '1:1'];
  return {
    default_model_id: 'wan-3-0-pro',
    models: [
      model(
        {
          id: 'wan-3-0-pro',
          name: 'Wan 3.0 Pro',
          provider_ids: {
            t2v: 'wan-3-0-pro-text-to-video',
            i2v: 'wan-3-0-pro-image-to-video',
            r2v: 'wan-3-0-pro-reference-to-video',
          },
          image_input: 'optional_first_frame',
          durations: [5, 10],
          resolutions: ['1080p'],
          aspect_ratios: supportedRatios,
          audio_configurable: true,
          default_audio: true,
          min_short_side: 240,
          enabled: true,
        },
        0
      ),
      model(
        {
          id: 'wan-3-0-reference',
          name: 'Wan 3.0 Reference',
          provider_ids: { r2v: 'wan-3-0-reference-to-video' },
          image_input: 'required_reference',
          durations: [5, 10],
          resolutions: ['720p', '1080p'],
          aspect_ratios: supportedRatios,
          audio_configurable: true,
          default_audio: true,
          min_short_side: 240,
        },
        1
      ),
      model(
        {
          id: 'minimax-h3-max',
          name: 'MiniMax H3 Max',
          provider_ids: {
            t2v: 'minimax-h3-max-text-to-video',
            i2v: 'minimax-h3-max-image-to-video',
          },
          image_input: 'optional_first_frame',
          durations: [5, 10],
          resolutions: ['1080P'],
          aspect_ratios: supportedRatios,
          audio_configurable: false,
          default_audio: true,
        },
        2
      ),
      model(
        {
          id: 'minimax-h3-max-r2v',
          name: 'MiniMax H3 Max R2V',
          provider_ids: { r2v: 'minimax-h3-max-reference-to-video' },
          image_input: 'required_reference',
          durations: [5, 10],
          resolutions: ['1080P'],
          aspect_ratios: supportedRatios,
          audio_configurable: false,
          default_audio: true,
          min_short_side: 256,
          min_ratio: 0.4,
          max_ratio: 2.5,
        },
        3
      ),
      model(
        {
          id: 'seedance-1-5-pro',
          name: 'Seedance 1.5 Pro',
          provider_ids: {
            t2v: 'seedance-1-5-pro-text-to-video-basic',
            i2v: 'seedance-1-5-pro-image-to-video-basic',
          },
          image_input: 'optional_first_frame',
          durations: [5, 10],
          resolutions: ['720p', '1080p'],
          aspect_ratios: supportedRatios,
          audio_configurable: true,
          default_audio: true,
          min_short_side: 300,
          min_ratio: 0.4,
          max_ratio: 2.5,
        },
        4
      ),
      model(
        {
          id: 'seedance-2-0-r2v',
          name: 'Seedance 2.0 R2V',
          provider_ids: { r2v: 'seedance-2-0-reference-to-video-basic' },
          image_input: 'required_reference',
          durations: [5, 10],
          resolutions: ['720p', '1080p'],
          aspect_ratios: supportedRatios,
          audio_configurable: true,
          default_audio: true,
          min_short_side: 300,
          min_ratio: 0.4,
          max_ratio: 2.5,
          seed_aliases: ['Seedance 2.0 R2V Enhanced'],
        },
        5
      ),
    ],
  };
}

export function getDefaultVideoPlazaModelOptions(modelId: string): {
  durations: number[];
  resolutions: string[];
  aspect_ratios: string[];
} | null {
  const model = createDefaultVideoCatalog().models.find((item) => item.id === modelId);
  return model
    ? {
        durations: [...model.durations],
        resolutions: [...model.resolutions],
        aspect_ratios: [...model.aspect_ratios],
      }
    : null;
}

export function normalizeVideoPlazaCatalogOptions(
  catalog: VideoPlazaModelCatalog
): VideoPlazaModelCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      const supported = selectSupportedVideoPlazaOptions(model);
      if (!supported) return model;
      const audioValues = model.audio_configurable ? [false, true] : [model.default_audio];
      const price_matrix = Object.fromEntries(
        supported.durations.flatMap((duration) =>
          supported.resolutions.flatMap((resolution) =>
            audioValues.map((audio) => {
              const key = `${duration}|${resolution}|${audio ? 1 : 0}`;
              return [key, model.price_matrix[key] ?? 1];
            })
          )
        )
      );
      return { ...model, ...supported, price_matrix };
    }),
  };
}
