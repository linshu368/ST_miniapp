import { z } from 'zod';

export const IMAGE_PLAZA_PROMPT_MAX_CHARS = 600;
export const IMAGE_PLAZA_PAGE_SIZE = 20;

export const ImagePlazaModeSchema = z.enum(['t2i', 'i2i', 'edit']);
export type ImagePlazaMode = z.infer<typeof ImagePlazaModeSchema>;

export const ImagePlazaAspectRatioSchema = z.enum([
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '4:5',
  '21:9',
]);
export type ImagePlazaAspectRatio = z.infer<typeof ImagePlazaAspectRatioSchema>;

export const ImagePlazaResolutionSchema = z.object({
  id: z.enum(['1K', '2K', 'fixed']),
  label: z.string().trim().min(1).max(20),
  credits: z.number().int().positive(),
});
export type ImagePlazaResolution = z.infer<typeof ImagePlazaResolutionSchema>;

export const ImagePlazaModelSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  supports_i2i: z.boolean(),
  supports_edit: z.boolean(),
  aspect_ratios: z.array(ImagePlazaAspectRatioSchema).min(1),
  resolutions: z.array(ImagePlazaResolutionSchema).min(1).max(12),
});
export type ImagePlazaModel = z.infer<typeof ImagePlazaModelSchema>;

const ProviderImagePlazaModelSchema = ImagePlazaModelSchema.extend({
  provider_model_id: z.string().trim().min(1).max(160),
  edit_provider_model_id: z.string().trim().min(1).max(160).nullable(),
  sizing_mode: z.enum(['aspect_ratio', 'resolution', 'pixels']),
  enabled: z.boolean(),
  sort_order: z.number().int().nonnegative(),
  internal_tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
}).superRefine((model, ctx) => {
  if (model.supports_edit && !model.edit_provider_model_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['edit_provider_model_id'],
      message: '支持编辑的模型必须配置编辑 Provider ID',
    });
  }
  if (model.supports_edit && !model.supports_i2i) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supports_edit'],
      message: '支持编辑的模型必须同时支持参考图',
    });
  }
  if (
    model.sizing_mode === 'resolution' &&
    model.resolutions.some((resolution) => resolution.id === 'fixed')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolutions'],
      message: '分辨率档模型不能使用 fixed 档位',
    });
  }
});
export type ProviderImagePlazaModel = z.infer<typeof ProviderImagePlazaModelSchema>;

export const ImagePlazaModelCatalogSchema = z
  .object({
    default_model_id: z.string().trim().min(1).max(80),
    models: z.array(ProviderImagePlazaModelSchema).min(1).max(30),
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
        message: '默认模型必须是已启用模型',
      });
    }
  });
export type ImagePlazaModelCatalog = z.infer<typeof ImagePlazaModelCatalogSchema>;

export const ImagePlazaShareTipConfigSchema = z
  .object({
    enabled: z.boolean(),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300),
    reference_note: z.string().trim().max(160),
    button_label: z.string().trim().min(1).max(40),
  })
  .superRefine((value, ctx) => {
    for (const [key, text] of Object.entries(value)) {
      if (typeof text !== 'string') continue;
      const placeholders = text.match(/\{[^}]+\}/g) ?? [];
      if (
        placeholders.some((placeholder) => placeholder !== '{rate}' && placeholder !== '{model}')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: '只允许 {rate} 与 {model} 占位符',
        });
      }
    }
  });
export type ImagePlazaShareTipConfig = z.infer<typeof ImagePlazaShareTipConfigSchema>;

export const ImagePlazaTagConfigSchema = z
  .array(
    z.object({
      id: z.string().trim().min(1).max(40),
      label: z.string().trim().min(1).max(40),
      enabled: z.boolean(),
      sort_order: z.number().int().nonnegative(),
    })
  )
  .max(80)
  .superRefine((tags, ctx) => {
    const ids = new Set<string>();
    for (const [index, tag] of tags.entries()) {
      if (tag.id === 'all') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: 'all 为系统保留 ID',
        });
      }
      if (ids.has(tag.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: '标签 ID 重复' });
      }
      ids.add(tag.id);
    }
  });
export type ImagePlazaTagConfig = z.infer<typeof ImagePlazaTagConfigSchema>;

export const ImagePlazaSnapshotSchema = z.object({
  prompt: z.string().max(IMAGE_PLAZA_PROMPT_MAX_CHARS),
  model_id: z.string(),
  aspect_ratio: ImagePlazaAspectRatioSchema,
  resolution: z.enum(['1K', '2K', 'fixed']),
  reasoning: z.boolean(),
  auto_optimize: z.boolean(),
  mode: ImagePlazaModeSchema,
  reference_artifact_id: z.string().uuid().nullable(),
  style: z.literal('None'),
});
export type ImagePlazaSnapshot = z.infer<typeof ImagePlazaSnapshotSchema>;

export const ImagePlazaWorkSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  image_url: z.string().url(),
  reference_image_url: z.string().url().nullable(),
  model_id: z.string(),
  model_name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tags: z.array(z.string()),
  like_count: z.number().int().nonnegative(),
  liked: z.boolean(),
  published_at: z.string().datetime(),
  snapshot: ImagePlazaSnapshotSchema,
});
export type ImagePlazaWork = z.infer<typeof ImagePlazaWorkSchema>;

const PublicImagePlazaTagSchema = z.object({ id: z.string(), label: z.string() });

export const GetImagePlazaFeedDataSchema = z.object({
  items: z.array(ImagePlazaWorkSchema),
  next_cursor: z.string().nullable(),
  tags: z.array(PublicImagePlazaTagSchema),
});
export type GetImagePlazaFeedData = z.infer<typeof GetImagePlazaFeedDataSchema>;

export const GetImagePlazaWorkDataSchema = z.object({ work: ImagePlazaWorkSchema });
export type GetImagePlazaWorkData = z.infer<typeof GetImagePlazaWorkDataSchema>;

export const GetImagePlazaConfigDataSchema = z.object({
  enabled: z.boolean(),
  models: z.array(ImagePlazaModelSchema),
  tags: z.array(PublicImagePlazaTagSchema),
  share_tip: ImagePlazaShareTipConfigSchema,
  share_rebate_rate: z.number().min(0).max(1),
  has_completed_first_share: z.boolean(),
});
export type GetImagePlazaConfigData = z.infer<typeof GetImagePlazaConfigDataSchema>;

export const ImagePlazaQuoteRequestSchema = z.object({
  model_id: z.string().trim().min(1).max(80),
  aspect_ratio: ImagePlazaAspectRatioSchema,
  resolution: z.enum(['1K', '2K', 'fixed']),
  mode: ImagePlazaModeSchema,
});
export type ImagePlazaQuoteRequest = z.infer<typeof ImagePlazaQuoteRequestSchema>;

export const ImagePlazaQuoteDataSchema = z.object({
  quote_id: z.string().uuid(),
  model_id: z.string(),
  aspect_ratio: ImagePlazaAspectRatioSchema,
  resolution: z.enum(['1K', '2K', 'fixed']),
  credits: z.number().positive(),
  expires_at: z.string().datetime(),
});
export type ImagePlazaQuoteData = z.infer<typeof ImagePlazaQuoteDataSchema>;

export type ImagePlazaAttemptStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'failed_unknown';

export const ImagePlazaArtifactSchema = z.object({
  id: z.string().uuid(),
  image_url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ImagePlazaArtifact = z.infer<typeof ImagePlazaArtifactSchema>;

export const ImagePlazaAttemptSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  status: z.enum(['pending', 'generating', 'ready', 'failed', 'failed_unknown']),
  quote_credits: z.number().positive(),
  error_code: z.string().nullable(),
  artifacts: z.array(ImagePlazaArtifactSchema).max(3),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ImagePlazaAttempt = z.infer<typeof ImagePlazaAttemptSchema>;

export const ImagePlazaMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  attempt: ImagePlazaAttemptSchema.nullable(),
  created_at: z.string().datetime(),
});
export type ImagePlazaMessage = z.infer<typeof ImagePlazaMessageSchema>;

export const ImagePlazaConversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  snapshot: ImagePlazaSnapshotSchema.nullable(),
  messages: z.array(ImagePlazaMessageSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ImagePlazaConversation = z.infer<typeof ImagePlazaConversationSchema>;

export const CreateImagePlazaConversationRequestSchema = z.object({
  source_work_id: z.string().uuid().optional(),
});
export type CreateImagePlazaConversationRequest = z.infer<
  typeof CreateImagePlazaConversationRequestSchema
>;

export const CreateImagePlazaConversationDataSchema = z.object({
  conversation: ImagePlazaConversationSchema,
});
export type CreateImagePlazaConversationData = z.infer<
  typeof CreateImagePlazaConversationDataSchema
>;

export const ImagePlazaConversationSummarySchema = ImagePlazaConversationSchema.omit({
  messages: true,
});
export const GetImagePlazaConversationsDataSchema = z.object({
  conversations: z.array(ImagePlazaConversationSummarySchema),
});
export type GetImagePlazaConversationsData = z.infer<typeof GetImagePlazaConversationsDataSchema>;

export const GetImagePlazaConversationDataSchema = z.object({
  conversation: ImagePlazaConversationSchema,
});
export type GetImagePlazaConversationData = z.infer<typeof GetImagePlazaConversationDataSchema>;

export const SubmitImagePlazaAttemptRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(IMAGE_PLAZA_PROMPT_MAX_CHARS),
  model_id: z.string().trim().min(1).max(80),
  aspect_ratio: ImagePlazaAspectRatioSchema,
  resolution: z.enum(['1K', '2K', 'fixed']),
  reasoning: z.boolean().default(false),
  auto_optimize: z.boolean().default(true),
  reference_artifact_id: z.string().uuid().nullable().optional(),
  mode: ImagePlazaModeSchema,
  quote_id: z.string().uuid(),
  idempotency_key: z.string().uuid(),
});
export type SubmitImagePlazaAttemptRequest = z.infer<typeof SubmitImagePlazaAttemptRequestSchema>;

export const SubmitImagePlazaAttemptDataSchema = z.object({ attempt: ImagePlazaAttemptSchema });
export type SubmitImagePlazaAttemptData = z.infer<typeof SubmitImagePlazaAttemptDataSchema>;

export const SetImagePlazaLikeDataSchema = z.object({
  liked: z.boolean(),
  like_count: z.number().int().nonnegative(),
});
export type SetImagePlazaLikeData = z.infer<typeof SetImagePlazaLikeDataSchema>;

export const SetImagePlazaLikeRequestSchema = z.object({ liked: z.boolean() });
export type SetImagePlazaLikeRequest = z.infer<typeof SetImagePlazaLikeRequestSchema>;

export const ShareImagePlazaWorkRequestSchema = z.object({
  artifact_id: z.string().uuid(),
  title: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});
export type ShareImagePlazaWorkRequest = z.infer<typeof ShareImagePlazaWorkRequestSchema>;

export const ShareImagePlazaWorkDataSchema = z.object({
  work: ImagePlazaWorkSchema,
  already_shared: z.boolean(),
  reward_credits: z.number().nonnegative(),
  has_completed_first_share: z.literal(true),
});
export type ShareImagePlazaWorkData = z.infer<typeof ShareImagePlazaWorkDataSchema>;

export const UploadImagePlazaReferenceRequestSchema = z.object({
  image_base64: z.string().min(1).max(28_000_000),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
});
export type UploadImagePlazaReferenceRequest = z.infer<
  typeof UploadImagePlazaReferenceRequestSchema
>;

export const UploadImagePlazaReferenceDataSchema = z.object({
  artifact: ImagePlazaArtifactSchema,
});
export type UploadImagePlazaReferenceData = z.infer<typeof UploadImagePlazaReferenceDataSchema>;
