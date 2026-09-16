import { z } from 'zod';

// 默认样本限制
export const BATCH_LAB_DEFAULT_SAMPLE_LIMIT = 50;
// 最大样本限制
export const BATCH_LAB_MAX_SAMPLE_LIMIT = 500;
// 最大 SQL 长度
export const BATCH_LAB_MAX_SQL_LENGTH = 20_000;
// 最大名称长度
export const BATCH_LAB_MAX_NAME_LENGTH = 120;
// 最大预览字节数
export const BATCH_LAB_MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
// 预览 TTL 秒
export const BATCH_LAB_PREVIEW_TTL_SECONDS = 15 * 60;

// 后端环境
export const batchLabBackendEnvironmentSchema = z.enum(['development', 'test', 'production']);
// 来源环境
export const batchLabSourceEnvironmentSchema = z.enum(['test', 'production']);
export type BatchLabSourceEnvironment = z.infer<typeof batchLabSourceEnvironmentSchema>;

// 上下文
export const batchLabContextSchema = z
  .object({
    backend_environment: batchLabBackendEnvironmentSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    capabilities: z
      .object({
        sample_preview: z.boolean(),
        experiment_execution: z.boolean(),
      })
      .strict(),
  })
  .strict();

// 上下文类型
export type BatchLabContext = z.infer<typeof batchLabContextSchema>;

// 上下文响应
export const batchLabContextResponseSchema = z
  .object({
    success: z.literal(true),
    data: batchLabContextSchema,
  })
  .strict();

// 错误码
export const batchLabErrorCodeSchema = z.enum([
  'BATCH_LAB_DISABLED',
  'BATCH_LAB_CONFIGURATION_ERROR',
  'BATCH_LAB_TIMEOUT',
  'BATCH_LAB_REQUEST_CANCELLED',
  'BATCH_LAB_NETWORK_ERROR',
  'BATCH_LAB_PROTOCOL_ERROR',
  'BATCH_LAB_INVALID_SQL',
  'BATCH_LAB_CAPACITY_EXCEEDED',
  'BATCH_LAB_SOURCE_UNAVAILABLE',
  'BATCH_LAB_ENVIRONMENT_MISMATCH',
  'BATCH_LAB_PREVIEW_NOT_FOUND',
  'BATCH_LAB_PREVIEW_EXPIRED',
  'BATCH_LAB_PREVIEW_MISMATCH',
  'BATCH_LAB_EMPTY_PREVIEW',
  'BATCH_LAB_IDEMPOTENCY_CONFLICT',
]);

// 错误响应
export const batchLabErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z
      .object({
        code: batchLabErrorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

// 错误码类型
export type BatchLabErrorCode = z.infer<typeof batchLabErrorCodeSchema>;

// 错误响应类型
export type BatchLabErrorResponse = z.infer<typeof batchLabErrorResponseSchema>;

// UUID 模式
const uuidSchema = z.string().uuid();
// ISO 日期时间模式
const isoDateTimeSchema = z.string().datetime({ offset: true });
// 摘要模式
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// 计数模式
const countSchema = z.number().int().nonnegative();

// SQL 参数值模式
export const batchLabSqlParameterValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type BatchLabSqlParameterValue = z.infer<typeof batchLabSqlParameterValueSchema>;

// SQL 模板模式
export const batchLabSqlTemplateSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    description: z.string().max(2_000),
    sql: z.string().min(1).max(BATCH_LAB_MAX_SQL_LENGTH),
    default_parameters: z.record(batchLabSqlParameterValueSchema),
    enabled: z.boolean(),
  })
  .strict();

// SQL 模板类型
export type BatchLabSqlTemplate = z.infer<typeof batchLabSqlTemplateSchema>;

// SQL 模板列表响应模式
export const batchLabSqlTemplateListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ items: z.array(batchLabSqlTemplateSchema) }).strict(),
  })
  .strict();

// 预览请求模式
export const batchLabPreviewRequestSchema = z
  .object({
    source_environment: batchLabSourceEnvironmentSchema,
    template_key: batchLabSqlTemplateSchema.shape.key.nullable(),
    template_version: z.number().int().positive().nullable(),
    sql: z.string().trim().min(1).max(BATCH_LAB_MAX_SQL_LENGTH),
    parameters: z.record(batchLabSqlParameterValueSchema),
    sample_limit: z
      .number()
      .int()
      .min(1)
      .max(BATCH_LAB_MAX_SAMPLE_LIMIT)
      .default(BATCH_LAB_DEFAULT_SAMPLE_LIMIT),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.template_key === null) !== (value.template_version === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'template_key and template_version must both be present or both be null',
      });
    }
  });

// 预览请求类型
export type BatchLabPreviewRequest = z.infer<typeof batchLabPreviewRequestSchema>;

// 预览排除原因模式
export const batchLabPreviewExclusionReasonSchema = z.enum([
  'duplicate_anchor',
  'missing_session',
  'missing_history',
  'missing_character',
  'invalid_anchor',
  'snapshot_too_large',
]);
export type BatchLabPreviewExclusionReason = z.infer<typeof batchLabPreviewExclusionReasonSchema>;

// 预览统计模式
export const batchLabPreviewStatisticsSchema = z
  .object({
    requested_count: z.number().int().positive(),
    candidate_count: countSchema,
    valid_count: countSchema,
    user_count: countSchema,
    session_count: countSchema,
    character_count: countSchema,
    excluded_by_reason: z.record(batchLabPreviewExclusionReasonSchema, countSchema),
    truncated: z.boolean(),
    snapshot_bytes: z.number().int().min(0).max(BATCH_LAB_MAX_PREVIEW_BYTES),
  })
  .strict();
export type BatchLabPreviewStatistics = z.infer<typeof batchLabPreviewStatisticsSchema>;

// 快照消息模式
export const batchLabSnapshotMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  })
  .strict();
export type BatchLabSnapshotMessage = z.infer<typeof batchLabSnapshotMessageSchema>;

// 预览项模式
export const batchLabPreviewItemSchema = z
  .object({
    ordinal: countSchema,
    source_history_id: uuidSchema,
    source_session_id: uuidSchema,
    source_user_id: uuidSchema,
    source_character_id: uuidSchema,
    turn_index: z.number().int().positive(),
    revision: countSchema,
    user_input: z.string(),
    original_assistant_reply: z.string().nullable(),
    original_model: z.string().min(1),
    history: z.array(batchLabSnapshotMessageSchema),
    character_snapshot: z.record(z.unknown()),
    dynamic_input_snapshot: z.record(z.unknown()),
    restoration_strategy: z.enum(['exact_prompt_snapshot', 'fixed_start']),
  })
  .strict();

// 预览项类型
export type BatchLabPreviewItem = z.infer<typeof batchLabPreviewItemSchema>;

// 预览模式
export const batchLabPreviewSchema = z
  .object({
    id: uuidSchema,
    digest: digestSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    final_sql: z.string().min(1).max(BATCH_LAB_MAX_SQL_LENGTH),
    parameters: z.record(batchLabSqlParameterValueSchema),
    sample_limit: z.number().int().min(1).max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    statistics: batchLabPreviewStatisticsSchema,
    items: z.array(batchLabPreviewItemSchema).max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    created_at: isoDateTimeSchema,
    expires_at: isoDateTimeSchema,
  })
  .strict();

// 预览类型
export type BatchLabPreview = z.infer<typeof batchLabPreviewSchema>;

// 预览响应模式
export const batchLabPreviewResponseSchema = z
  .object({ success: z.literal(true), data: batchLabPreviewSchema })
  .strict();

// 创建样本集请求模式
export const batchLabCreateSampleSetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    preview_id: uuidSchema,
    preview_digest: digestSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    idempotency_key: uuidSchema,
  })
  .strict();

// 创建样本集请求类型
export type BatchLabCreateSampleSetRequest = z.infer<typeof batchLabCreateSampleSetRequestSchema>;

// 样本集模式
export const batchLabSampleSetSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(BATCH_LAB_MAX_NAME_LENGTH),
    source_environment: batchLabSourceEnvironmentSchema,
    source_preview_id: uuidSchema,
    source_digest: digestSchema,
    sample_count: z.number().int().positive().max(BATCH_LAB_MAX_SAMPLE_LIMIT),
    statistics: batchLabPreviewStatisticsSchema,
    created_at: isoDateTimeSchema,
  })
  .strict();

// 样本集类型
export type BatchLabSampleSet = z.infer<typeof batchLabSampleSetSchema>;

// 样本集响应模式
export const batchLabSampleSetResponseSchema = z
  .object({ success: z.literal(true), data: batchLabSampleSetSchema })
  .strict();

// 样本集列表响应模式
export const batchLabSampleSetListResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        items: z.array(batchLabSampleSetSchema),
        next_cursor: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();
