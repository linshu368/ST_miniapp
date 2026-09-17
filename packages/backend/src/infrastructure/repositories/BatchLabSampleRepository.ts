import {
  batchLabPreviewItemSchema,
  batchLabPreviewStatisticsSchema,
  batchLabSampleSetDetailSchema,
  batchLabSampleSetSchema,
  batchLabSqlTemplateSchema,
  type BatchLabCreateSampleSetRequest,
  type BatchLabErrorCode,
  type BatchLabPreview,
  type BatchLabPreviewItem,
  type BatchLabPreviewStatistics,
  type BatchLabSampleSet,
  type BatchLabSampleSetDetail,
  type BatchLabSampleSnapshotPage,
  type BatchLabSourceEnvironment,
  type BatchLabSqlParameterValue,
  type BatchLabSqlTemplate,
} from '@miniapp/shared';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';

interface DatabaseErrorLike {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
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
  frozen_sql?: string;
  frozen_parameters?: Record<string, BatchLabSqlParameterValue>;
  created_at: string;
  deleted_at?: string | null;
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
      .select(SAMPLE_SET_SELECT)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error && isMissingDeletedAtColumn(error)) {
      const legacy = await this.db
        .from('sample_sets')
        .select(SAMPLE_SET_SELECT_LEGACY)
        .order('created_at', { ascending: false })
        .limit(safeLimit);
      if (legacy.error) throw repositoryError(legacy.error);
      return ((legacy.data ?? []) as SampleSetRow[]).map(toSampleSet);
    }
    if (error) throw repositoryError(error);
    return ((data ?? []) as SampleSetRow[]).map(toSampleSet);
  }

  async getSampleSetDetail(id: string): Promise<BatchLabSampleSetDetail> {
    const { data, error } = await this.db
      .from('sample_sets')
      .select(`${SAMPLE_SET_SELECT},frozen_sql,frozen_parameters`)
      .eq('id', id)
      .limit(1);
    if (error && isMissingDeletedAtColumn(error)) {
      const legacy = await this.db
        .from('sample_sets')
        .select(`${SAMPLE_SET_SELECT_LEGACY},frozen_sql,frozen_parameters`)
        .eq('id', id)
        .limit(1);
      if (legacy.error) throw repositoryError(legacy.error);
      const legacyRow = ((legacy.data ?? []) as SampleSetRow[])[0];
      if (legacyRow) return toSampleSetDetail(legacyRow);
    }
    if (error) throw repositoryError(error);
    const row = ((data ?? []) as SampleSetRow[])[0];
    if (!row) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_SAMPLE_SET_NOT_FOUND',
        'Batch Lab sample set was not found'
      );
    }
    return toSampleSetDetail(row);
  }

  async listSampleSnapshots(
    sampleSetId: string,
    input: { limit?: number; cursor?: string | null } = {}
  ): Promise<BatchLabSampleSnapshotPage> {
    const safeLimit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const cursorOrdinal = input.cursor ? Number.parseInt(input.cursor, 10) : null;
    let query = this.db
      .from('sample_snapshots')
      .select(
        'ordinal,source_history_id,source_session_id,source_user_id,source_character_id,turn_index,revision,user_input,original_assistant_reply,original_model,history,character_snapshot,dynamic_input_snapshot,restoration_strategy'
      )
      .eq('sample_set_id', sampleSetId)
      .order('ordinal')
      .limit(safeLimit + 1);
    if (cursorOrdinal !== null && Number.isFinite(cursorOrdinal)) {
      query = query.gte('ordinal', cursorOrdinal);
    }
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    const rows = ((data ?? []) as BatchLabPreviewItem[]).map((row) =>
      batchLabPreviewItemSchema.parse(row)
    );
    const items = rows.slice(0, safeLimit);
    const extra = rows.length > safeLimit ? rows[safeLimit] : null;
    return {
      sample_set_id: sampleSetId,
      items,
      next_cursor: extra ? String(extra.ordinal) : null,
    };
  }

  async softDeleteSampleSet(input: {
    id: string;
    sourceEnvironment: BatchLabSourceEnvironment;
  }): Promise<{ id: string; deleted_at: string }> {
    const deletedAt = new Date().toISOString();
    const { data, error } = await this.db
      .from('sample_sets')
      .update({ deleted_at: deletedAt })
      .eq('id', input.id)
      .eq('source_environment', input.sourceEnvironment)
      .is('deleted_at', null)
      .select('id,deleted_at')
      .limit(1);
    if (error) throw repositoryError(error);
    const row = ((data ?? []) as Array<{ id: string; deleted_at: string }>)[0];
    if (!row) {
      const existing = await this.getSampleSetDetail(input.id);
      if (existing.source_environment !== input.sourceEnvironment) {
        throw new BatchLabRepositoryError(
          'BATCH_LAB_ENVIRONMENT_MISMATCH',
          'Batch Lab source environment mismatch'
        );
      }
      if (existing.deleted_at) return { id: existing.id, deleted_at: existing.deleted_at };
      throw new BatchLabRepositoryError(
        'BATCH_LAB_SAMPLE_SET_NOT_FOUND',
        'Batch Lab sample set was not found'
      );
    }
    return row;
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

const SAMPLE_SET_SELECT =
  'id,name,source_environment,source_preview_id,source_digest,sample_count,statistics,created_at,deleted_at';

const SAMPLE_SET_SELECT_LEGACY =
  'id,name,source_environment,source_preview_id,source_digest,sample_count,statistics,created_at';

function isMissingDeletedAtColumn(error: DatabaseErrorLike): boolean {
  const text = `${error.code ?? ''} ${error.message ?? ''}`;
  return text.includes('42703') || text.includes('PGRST204') || text.includes('deleted_at');
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
    deleted_at: row.deleted_at ?? null,
  });
}

export function toSampleSetDetail(row: SampleSetRow): BatchLabSampleSetDetail {
  return batchLabSampleSetDetailSchema.parse({
    ...toSampleSet(row),
    frozen_sql: row.frozen_sql,
    frozen_parameters: row.frozen_parameters ?? {},
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
    'BATCH_LAB_EXPERIMENT_NOT_FOUND',
    'BATCH_LAB_EXPERIMENT_STATE_CONFLICT',
    'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR',
    'BATCH_LAB_EXPERIMENT_NO_WORK',
    'BATCH_LAB_SAMPLE_SET_NOT_FOUND',
    'BATCH_LAB_SAMPLE_SET_IN_USE',
  ];
  const originalMessage = [error.message, error.details, error.hint].filter(Boolean).join(' · ');
  if (
    error.code === 'PGRST202' &&
    originalMessage.includes('claim_experiment_attempts_for_experiment')
  ) {
    return new BatchLabRepositoryError(
      'BATCH_LAB_CONFIGURATION_ERROR',
      'Batch Lab targeted worker migration is not applied',
      { cause: error }
    );
  }
  const code = knownCodes.find((candidate) => originalMessage.includes(candidate));
  return new BatchLabRepositoryError(
    code ?? 'BATCH_LAB_SOURCE_UNAVAILABLE',
    code
      ? '样本数据状态已变化，请刷新后重试'
      : `Batch Lab 数据库暂不可用${error.code ? `（${error.code}）` : ''}${originalMessage ? `：${originalMessage}` : ''}`,
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
