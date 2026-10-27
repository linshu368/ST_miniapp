import { z } from 'zod';

export const VIDEO_PLAZA_MAX_FILE_BYTES = 200 * 1024 * 1024;

export const VideoPlazaInputModeSchema = z.enum(['t2v', 'i2v', 'r2v']);
export type VideoPlazaInputMode = z.infer<typeof VideoPlazaInputModeSchema>;

export const VideoPlazaImageInputSchema = z.enum([
  'none',
  'optional_first_frame',
  'optional_reference',
  'required_reference',
]);
export type VideoPlazaImageInput = z.infer<typeof VideoPlazaImageInputSchema>;

export const VideoPlazaImageConstraintsSchema = z.object({
  min_short_side: z.number().int().positive().max(16_384).optional(),
  min_ratio: z.number().finite().positive().max(10).optional(),
  max_ratio: z.number().finite().positive().max(10).optional(),
});
export type VideoPlazaImageConstraints = z.infer<typeof VideoPlazaImageConstraintsSchema>;

export const VideoPlazaModelSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  image_input: VideoPlazaImageInputSchema,
  durations: z.array(z.number().int().positive().max(300)).min(1).max(60),
  resolutions: z.array(z.string().trim().min(1).max(24)).min(1).max(20),
  aspect_ratios: z.array(z.string().trim().min(1).max(24)).max(20),
  audio_configurable: z.boolean(),
  default_audio: z.boolean(),
  default_duration: z.number().int().positive().max(300),
  default_resolution: z.string().trim().min(1).max(24),
  default_aspect_ratio: z.string().trim().min(1).max(24).nullable(),
  image_constraints: VideoPlazaImageConstraintsSchema.default({}),
});
export type VideoPlazaModel = z.infer<typeof VideoPlazaModelSchema>;

const ProviderVideoPlazaModelBaseSchema = VideoPlazaModelSchema.extend({
  provider_ids: z.object({
    t2v: z.string().trim().min(1).max(160).optional(),
    i2v: z.string().trim().min(1).max(160).optional(),
    r2v: z.string().trim().min(1).max(160).optional(),
  }),
  enabled: z.boolean(),
  sort_order: z.number().int().nonnegative(),
  price_matrix: z.record(z.number().finite().positive().max(1_000_000)),
  seed_aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});

function priceKey(duration: number, resolution: string, audio: boolean): string {
  return `${duration}|${resolution}|${audio ? 1 : 0}`;
}

export const ProviderVideoPlazaModelSchema = ProviderVideoPlazaModelBaseSchema.superRefine(
  (model, ctx) => {
    if (!model.durations.includes(model.default_duration)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_duration'],
        message: '默认时长必须位于可选时长中',
      });
    }
    if (!model.resolutions.includes(model.default_resolution)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_resolution'],
        message: '默认分辨率必须位于可选分辨率中',
      });
    }
    if (
      (model.default_aspect_ratio === null && model.aspect_ratios.length > 0) ||
      (model.default_aspect_ratio !== null &&
        !model.aspect_ratios.includes(model.default_aspect_ratio))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_aspect_ratio'],
        message: '默认比例必须与可选比例一致',
      });
    }
    if (model.image_constraints.min_ratio && model.image_constraints.max_ratio) {
      if (model.image_constraints.min_ratio > model.image_constraints.max_ratio) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['image_constraints'],
          message: '图片最小宽高比不能大于最大宽高比',
        });
      }
    }

    const { t2v, i2v, r2v } = model.provider_ids;
    if (model.image_input === 'none' && (!t2v || i2v || r2v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provider_ids'],
        message: '不支持图片的模型必须只配置 t2v Provider ID',
      });
    }
    if (model.image_input === 'optional_first_frame' && (!t2v || !i2v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provider_ids'],
        message: '可选首帧模型必须配置 t2v 和 i2v Provider ID',
      });
    }
    if (model.image_input === 'optional_reference' && (!t2v || !r2v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provider_ids'],
        message: '可选参考图模型必须配置 t2v 和 r2v Provider ID',
      });
    }
    if (model.image_input === 'required_reference' && (t2v || (!i2v && !r2v))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provider_ids'],
        message: '必需图片的模型不能配置 t2v，且必须配置 i2v 或 r2v Provider ID',
      });
    }

    const audioValues = model.audio_configurable ? [false, true] : [model.default_audio];
    const expectedKeys = new Set<string>();
    for (const duration of model.durations) {
      for (const resolution of model.resolutions) {
        for (const audio of audioValues) {
          expectedKeys.add(priceKey(duration, resolution, audio));
        }
      }
    }
    for (const key of expectedKeys) {
      if (model.price_matrix[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['price_matrix', key],
          message: `价格矩阵缺少组合 ${key}`,
        });
      }
    }
    for (const key of Object.keys(model.price_matrix)) {
      if (!expectedKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['price_matrix', key],
          message: `价格矩阵包含未知组合 ${key}`,
        });
      }
    }
  }
);
export type ProviderVideoPlazaModel = z.infer<typeof ProviderVideoPlazaModelSchema>;

export const VideoPlazaModelCatalogSchema = z
  .object({
    default_model_id: z.string().trim().min(1).max(80),
    models: z.array(ProviderVideoPlazaModelSchema).min(1).max(30),
    standard_prices: z
      .record(
        z
          .number()
          .finite()
          .positive()
          .max(1_000_000)
          .refine((value) => Number(value.toFixed(4)) === value, '标准价最多四位小数')
          .nullable()
      )
      .optional(),
  })
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    for (const [index, model] of catalog.models.entries()) {
      if (ids.has(model.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'id'],
          message: `模型 ID 重复：${model.id}`,
        });
      }
      ids.add(model.id);
    }
    if (!catalog.models.some((model) => model.id === catalog.default_model_id && model.enabled)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_model_id'],
        message: '默认视频模型必须是已启用模型',
      });
    }
  });
export type VideoPlazaModelCatalog = z.infer<typeof VideoPlazaModelCatalogSchema>;

export const VideoPlazaParamsSchema = z.object({
  model_id: z.string().trim().min(1).max(80),
  input_mode: VideoPlazaInputModeSchema,
  duration_s: z.number().int().positive().max(300),
  resolution: z.string().trim().min(1).max(24),
  aspect_ratio: z.string().trim().min(1).max(24).nullable(),
  audio: z.boolean(),
  reference_artifact_id: z.string().uuid().nullable(),
});
export type VideoPlazaParams = z.infer<typeof VideoPlazaParamsSchema>;

export const VideoPlazaQuoteRequestSchema = VideoPlazaParamsSchema.omit({
  reference_artifact_id: true,
}).strict();
export type VideoPlazaQuoteRequest = z.infer<typeof VideoPlazaQuoteRequestSchema>;

export const VideoPlazaQuoteDataSchema = VideoPlazaQuoteRequestSchema.extend({
  quote_id: z.string().uuid(),
  credits: z.number().finite().positive(),
  expires_at: z.string().datetime(),
});
export type VideoPlazaQuoteData = z.infer<typeof VideoPlazaQuoteDataSchema>;

export const SubmitVideoPlazaAttemptRequestSchema = z
  .object({
    prompt: z.string().trim().min(1),
    quote_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
    reference_artifact_id: z.string().uuid().nullable().optional(),
  })
  .strict();
export type SubmitVideoPlazaAttemptRequest = z.infer<typeof SubmitVideoPlazaAttemptRequestSchema>;

export const VideoPlazaAttemptStatusSchema = z.enum([
  'pending',
  'submitting',
  'queued',
  'processing',
  'storing',
  'ready',
  'failed',
  'moderation_rejected',
  'expired',
  'failed_unknown',
]);
export type VideoPlazaAttemptStatus = z.infer<typeof VideoPlazaAttemptStatusSchema>;

export const VideoPlazaArtifactSchema = z.object({
  id: z.string().uuid(),
  video_url: z.string().url(),
  poster_url: z.string().url().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration_ms: z.number().int().positive(),
});
export type VideoPlazaArtifact = z.infer<typeof VideoPlazaArtifactSchema>;

export const VideoPlazaAttemptSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  status: VideoPlazaAttemptStatusSchema,
  error_code: z.string().nullable(),
  quote_credits: z.number().finite().positive(),
  params: VideoPlazaParamsSchema,
  artifact: VideoPlazaArtifactSchema.nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type VideoPlazaAttempt = z.infer<typeof VideoPlazaAttemptSchema>;

export const SubmitVideoPlazaAttemptDataSchema = z.object({ attempt: VideoPlazaAttemptSchema });
export type SubmitVideoPlazaAttemptData = z.infer<typeof SubmitVideoPlazaAttemptDataSchema>;

export const VideoPlazaSnapshotSchema = z.object({
  prompt: z.string().min(1),
  prompt_zh: z.string().min(1).optional(),
  prompt_zh_source: z.literal('translation_pack').optional(),
  model_id: z.string().trim().min(1).max(80),
  input_mode: VideoPlazaInputModeSchema,
  duration_s: z.number().int().positive().max(300),
  resolution: z.string().trim().min(1).max(24),
  aspect_ratio: z.string().trim().min(1).max(24).nullable(),
  audio: z.boolean(),
  reference_artifact_id: z.string().uuid().nullable(),
  source_heat: z.number().int().nonnegative().optional(),
});
export type VideoPlazaSnapshot = z.infer<typeof VideoPlazaSnapshotSchema>;

export const PlazaVideoFeedItemSchema = z.object({
  id: z.string().uuid(),
  media_type: z.literal('video'),
  title: z.string(),
  poster_url: z.string().url().nullable(),
  duration_ms: z.number().int().positive(),
  description: z.string(),
  model_id: z.string(),
  model_name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tags: z.array(z.string()),
  like_count: z.number().int().nonnegative(),
  liked: z.boolean(),
  published_at: z.string().datetime(),
});
export type PlazaVideoFeedItem = z.infer<typeof PlazaVideoFeedItemSchema>;

export const PlazaVideoWorkSchema = PlazaVideoFeedItemSchema.extend({
  attempt_id: z.string().uuid(),
  video_url: z.string().url(),
  snapshot: VideoPlazaSnapshotSchema,
});
export type PlazaVideoWork = z.infer<typeof PlazaVideoWorkSchema>;

export const GetVideoPlazaWorkDataSchema = z.object({ work: PlazaVideoWorkSchema });
export type GetVideoPlazaWorkData = z.infer<typeof GetVideoPlazaWorkDataSchema>;

export const GetVideoPlazaAttemptDataSchema = z.object({ attempt: VideoPlazaAttemptSchema });
export type GetVideoPlazaAttemptData = z.infer<typeof GetVideoPlazaAttemptDataSchema>;

export const GetVideoPlazaPlaybackDataSchema = z.object({
  artifact_id: z.string().uuid(),
  video_url: z.string().url(),
  poster_url: z.string().url().nullable(),
  expires_at: z.string().datetime(),
});
export type GetVideoPlazaPlaybackData = z.infer<typeof GetVideoPlazaPlaybackDataSchema>;

export const ShareVideoPlazaWorkRequestSchema = z
  .object({
    artifact_id: z.string().uuid(),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  })
  .strict();
export type ShareVideoPlazaWorkRequest = z.infer<typeof ShareVideoPlazaWorkRequestSchema>;

export const ShareVideoPlazaWorkDataSchema = z.object({
  work: PlazaVideoWorkSchema,
  already_shared: z.boolean(),
  reward_credits: z.number().nonnegative(),
  has_completed_first_share: z.literal(true),
});
export type ShareVideoPlazaWorkData = z.infer<typeof ShareVideoPlazaWorkDataSchema>;

export const VideoPlazaTagCountsQuerySchema = z.object({
  media: z.enum(['all', 'image', 'video']).default('all'),
  search: z.string().trim().max(80).optional(),
});
export type VideoPlazaTagCountsQuery = z.infer<typeof VideoPlazaTagCountsQuerySchema>;

export const GetVideoPlazaTagCountsDataSchema = z.object({
  counts: z.record(z.number().int().nonnegative()),
});
export type GetVideoPlazaTagCountsData = z.infer<typeof GetVideoPlazaTagCountsDataSchema>;
