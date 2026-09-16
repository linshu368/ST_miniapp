import {
  batchLabPreviewItemSchema,
  batchLabPreviewStatisticsSchema,
  batchLabSampleSetSchema,
  batchLabSqlTemplateSchema,
  type BatchLabCreateSampleSetRequest,
  type BatchLabErrorCode,
  type BatchLabPreview,
  type BatchLabPreviewItem,
  type BatchLabPreviewStatistics,
  type BatchLabSampleSet,
  type BatchLabSourceEnvironment,
  type BatchLabSqlParameterValue,
  type BatchLabSqlTemplate,
} from '@miniapp/shared';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';

interface DatabaseErrorLike {
  code?: string;
  message?: string;
}

export class BatchLabRepositoryError extends Error {
  constructor(
    readonly code: BatchLabErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'BatchLabRepositoryError';
  }
}

interface PreviewRow {
  id: string;
  digest: string;
  source_environment: BatchLabSourceEnvironment;
  final_sql: string;
  parameters: Record<string, BatchLabSqlParameterValue>;
  sample_limit: number;
  statistics: BatchLabPreviewStatistics;
  created_at: string;
  expires_at: string;
}

interface SampleSetRow {
  id: string;
  name: string;
  source_environment: BatchLabSourceEnvironment;
  source_preview_id: string;
  source_digest: string;
  sample_count: number;
  statistics: BatchLabPreviewStatistics;
  created_at: string;
}

interface SqlTemplateRow {
  key: string;
  version: number;
  name: string;
  description: string;
  sql_body: string;
  parameter_defaults: Record<string, BatchLabSqlParameterValue>;
  enabled: boolean;
}

export interface CreateBatchLabPreviewInput extends Omit<BatchLabPreview, 'id' | 'created_at'> {
  template_key: string | null;
  template_version: number | null;
}

export class BatchLabSampleRepository {
  constructor(private readonly db: DomainDb = getDomainDb('batch_lab')) {}

  async listTemplates(): Promise<BatchLabSqlTemplate[]> {
    const { data, error } = await this.db
      .from('sql_templates')
      .select('key,version,name,description,sql_body,parameter_defaults,enabled')
      .eq('enabled', true)
      .order('key')
      .order('version', { ascending: false });
    if (error) throw repositoryError(error);
    return ((data ?? []) as SqlTemplateRow[]).map(toSqlTemplate);
  }

  async createPreview(input: CreateBatchLabPreviewInput): Promise<BatchLabPreview> {
    const items = input.items.map((item) => batchLabPreviewItemSchema.parse(item));
    const { data, error } = await this.db.rpc('create_sample_preview', {
      p_digest: input.digest,
      p_source_environment: input.source_environment,
      p_template_key: input.template_key,
      p_template_version: input.template_version,
      p_final_sql: input.final_sql,
      p_parameters: input.parameters,
      p_sample_limit: input.sample_limit,
      p_statistics: input.statistics,
      p_snapshot_bytes: input.statistics.snapshot_bytes,
      p_expires_at: input.expires_at,
      p_items: items,
    });
    if (error) throw repositoryError(error);
    const row = expectFirst<PreviewRow>(data, '创建样本预览未返回记录');
    return toPreview(row, items);
  }

  async freezeSampleSet(input: BatchLabCreateSampleSetRequest): Promise<BatchLabSampleSet> {
    const { data, error } = await this.db.rpc('freeze_sample_set', {
      p_name: input.name,
      p_preview_id: input.preview_id,
      p_preview_digest: input.preview_digest,
      p_source_environment: input.source_environment,
      p_idempotency_key: input.idempotency_key,
    });
    if (error) throw repositoryError(error);
    return toSampleSet(expectFirst<SampleSetRow>(data, '冻结样本集未返回记录'));
  }

  async listSampleSets(limit = 50): Promise<BatchLabSampleSet[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const { data, error } = await this.db
      .from('sample_sets')
      .select(
        'id,name,source_environment,source_preview_id,source_digest,sample_count,statistics,created_at'
      )
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error) throw repositoryError(error);
    return ((data ?? []) as SampleSetRow[]).map(toSampleSet);
  }
}

export function toSqlTemplate(row: SqlTemplateRow): BatchLabSqlTemplate {
  return batchLabSqlTemplateSchema.parse({
    key: row.key,
    version: row.version,
    name: row.name,
    description: row.description,
    sql: row.sql_body,
    default_parameters: row.parameter_defaults,
    enabled: row.enabled,
  });
}

export function toSampleSet(row: SampleSetRow): BatchLabSampleSet {
  return batchLabSampleSetSchema.parse({
    id: row.id,
    name: row.name,
    source_environment: row.source_environment,
    source_preview_id: row.source_preview_id,
    source_digest: row.source_digest,
    sample_count: row.sample_count,
    statistics: batchLabPreviewStatisticsSchema.parse(row.statistics),
    created_at: row.created_at,
  });
}

export function repositoryError(error: DatabaseErrorLike): BatchLabRepositoryError {
  const knownCodes: BatchLabErrorCode[] = [
    'BATCH_LAB_PREVIEW_NOT_FOUND',
    'BATCH_LAB_PREVIEW_EXPIRED',
    'BATCH_LAB_PREVIEW_MISMATCH',
    'BATCH_LAB_EMPTY_PREVIEW',
    'BATCH_LAB_IDEMPOTENCY_CONFLICT',
    'BATCH_LAB_CAPACITY_EXCEEDED',
    'BATCH_LAB_PROCESSOR_NOT_FOUND',
    'BATCH_LAB_PROCESSOR_VALIDATION_ERROR',
    'BATCH_LAB_PROCESSOR_TIMEOUT',
    'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED',
    'BATCH_LAB_PROCESSOR_RUNTIME_ERROR',
  ];
  const code = knownCodes.find((candidate) => error.message?.includes(candidate));
  return new BatchLabRepositoryError(
    code ?? 'BATCH_LAB_SOURCE_UNAVAILABLE',
    code ? '样本数据状态已变化，请刷新后重试' : 'Batch Lab 数据库暂不可用',
    { cause: error }
  );
}

function toPreview(row: PreviewRow, items: BatchLabPreviewItem[]): BatchLabPreview {
  return {
    id: row.id,
    digest: row.digest,
    source_environment: row.source_environment,
    final_sql: row.final_sql,
    parameters: row.parameters,
    sample_limit: row.sample_limit,
    statistics: batchLabPreviewStatisticsSchema.parse(row.statistics),
    items,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

function expectFirst<T>(value: unknown, message: string): T {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BatchLabRepositoryError('BATCH_LAB_PROTOCOL_ERROR', message);
  }
  return value[0] as T;
}
