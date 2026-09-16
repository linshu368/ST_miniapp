import {
  BATCH_LAB_JSONL_SCHEMA_VERSION,
  batchLabAnnotationSchema,
  batchLabExperimentDetailSchema,
  batchLabExportRowSchema,
  batchLabExperimentSummarySchema,
  type BatchLabAnnotation,
  type BatchLabCopyExperimentRequest,
  type BatchLabCreateExperimentRequest,
  type BatchLabExperimentDetail,
  type BatchLabExperimentSummary,
  type BatchLabExperimentVariant,
  type BatchLabExportAttempt,
  type BatchLabExportRow,
  type BatchLabReuseDisplayExperimentRequest,
  type BatchLabStartExperimentRequest,
  type BatchLabUpsertAnnotationRequest,
} from '@miniapp/shared';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import { BatchLabRepositoryError, repositoryError } from './BatchLabSampleRepository.js';

interface ExperimentRow {
  id: string;
  name: string;
  source_environment: 'test' | 'production';
  sample_set_id: string;
  status: BatchLabExperimentSummary['status'];
  variants: BatchLabExperimentVariant[];
  total_attempts: number;
  completed_attempts: number;
  failed_attempts: number;
  kind?: 'generation' | 'reuse_display';
  source_experiment_id?: string | null;
  generation_source_experiment_id?: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ExperimentAttemptRow {
  id: string;
  experiment_id: string;
  sample_set_id: string;
  sample_ordinal: number;
  variant_key: string;
  turn_index: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'unknown';
  attempt_count: number;
  generation_id?: string | null;
  finish_reason?: string | null;
  raw_output?: string | null;
  display_result_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface ExecutionSampleSnapshot {
  ordinal?: number;
  source_history_id?: string;
  source_session_id?: string;
  source_user_id: string;
  source_character_id: string;
  user_input: string;
  history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  turn_index?: number;
  revision?: number;
  original_assistant_reply?: string | null;
  original_model: string;
  character_snapshot?: Record<string, unknown>;
  dynamic_input_snapshot?: Record<string, unknown>;
  restoration_strategy?: 'exact_prompt_snapshot' | 'fixed_start';
}

export interface ExecutionContext {
  experiment: BatchLabExperimentSummary;
  variant: BatchLabExperimentVariant;
  sample: ExecutionSampleSnapshot;
  previousOutputs: string[];
}

export interface CompleteAttemptInput {
  attemptId: string;
  generationId: string | null;
  finishReason: string | null;
  rawOutput: string;
  displayResultId: string | null;
}

export interface FailAttemptInput {
  attempt: ExperimentAttemptRow;
  attemptId: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}

export class BatchLabExecutionRepository {
  constructor(private readonly db: DomainDb = getDomainDb('batch_lab')) {}

  async createExperiment(
    input: BatchLabCreateExperimentRequest
  ): Promise<BatchLabExperimentSummary> {
    const { data, error } = await this.db.rpc('create_experiment', {
      p_name: input.name,
      p_sample_set_id: input.sample_set_id,
      p_source_environment: input.source_environment,
      p_variants: input.variants,
      p_idempotency_key: input.idempotency_key,
    });
    if (error) throw repositoryError(error);
    return toExperiment(expectFirst<ExperimentRow>(data, 'experiment'));
  }

  async startExperiment(input: BatchLabStartExperimentRequest): Promise<BatchLabExperimentSummary> {
    const { data, error } = await this.db.rpc('start_experiment', {
      p_experiment_id: input.experiment_id,
      p_source_environment: input.source_environment,
      p_idempotency_key: input.idempotency_key,
    });
    if (error) throw repositoryError(error);
    return toExperiment(expectFirst<ExperimentRow>(data, 'experiment'));
  }

  async listExperiments(limit = 50): Promise<BatchLabExperimentSummary[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const { data, error } = await this.db
      .from('experiments')
      .select(
        'id,name,source_environment,sample_set_id,status,variants,total_attempts,completed_attempts,failed_attempts,created_at,started_at,completed_at'
      )
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error) throw repositoryError(error);
    return ((data ?? []) as ExperimentRow[]).map(toExperiment);
  }

  async getExperimentDetail(id: string): Promise<BatchLabExperimentDetail> {
    return toExperimentDetail(await this.getExperimentRow(id));
  }

  async copyExperiment(input: BatchLabCopyExperimentRequest): Promise<BatchLabExperimentSummary> {
    const source = await this.getExperimentDetail(input.source_experiment_id);
    if (source.source_environment !== input.source_environment) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_ENVIRONMENT_MISMATCH',
        'Batch Lab source environment mismatch'
      );
    }
    const copied = await this.createExperiment({
      name: input.name,
      sample_set_id: source.sample_set_id,
      source_environment: input.source_environment,
      variants: source.variants.map((variant) => ({ ...variant })),
      idempotency_key: input.idempotency_key,
    });
    await this.updateExperimentLineage(copied.id, {
      kind: 'generation',
      sourceExperimentId: source.id,
      generationSourceExperimentId: source.lineage.generation_source_experiment_id ?? source.id,
    });
    return this.getExperiment(copied.id);
  }

  async createReuseDisplayExperiment(
    input: BatchLabReuseDisplayExperimentRequest
  ): Promise<BatchLabExperimentSummary> {
    const source = await this.getExperimentDetail(input.source_experiment_id);
    if (source.source_environment !== input.source_environment) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_ENVIRONMENT_MISMATCH',
        'Batch Lab source environment mismatch'
      );
    }
    const row = {
      name: input.name,
      source_environment: input.source_environment,
      sample_set_id: source.sample_set_id,
      idempotency_key: input.idempotency_key,
      status: 'completed',
      variants: input.variants,
      kind: 'reuse_display',
      source_experiment_id: source.id,
      generation_source_experiment_id: source.lineage.generation_source_experiment_id ?? source.id,
      total_attempts: 0,
      completed_attempts: 0,
      failed_attempts: 0,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    const { data, error } = await this.db
      .from('experiments')
      .insert(row)
      .select(EXPERIMENT_SELECT)
      .limit(1);
    if (error) {
      const existing = await this.findExperimentByIdempotency(input.idempotency_key);
      if (existing) return existing;
      throw repositoryError(error);
    }
    return toExperiment(expectFirst<ExperimentRow>(data, 'reuse experiment'));
  }

  async upsertAnnotation(input: BatchLabUpsertAnnotationRequest): Promise<BatchLabAnnotation> {
    const experiment = await this.getExperimentDetail(input.experiment_id);
    if (experiment.source_environment !== input.source_environment) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_ENVIRONMENT_MISMATCH',
        'Batch Lab source environment mismatch'
      );
    }
    const existing = await this.findAnnotation(
      input.experiment_id,
      input.sample_ordinal,
      input.turn_index
    );
    if (existing) {
      let query = this.db
        .from('annotations')
        .update({ tag: input.tag, note: input.note, updated_at: new Date().toISOString() })
        .eq('experiment_id', input.experiment_id);
      query =
        input.sample_ordinal === null
          ? query.is('sample_ordinal', null)
          : query.eq('sample_ordinal', input.sample_ordinal);
      query =
        input.turn_index === null
          ? query.is('turn_index', null)
          : query.eq('turn_index', input.turn_index);
      const { data, error } = await query
        .select('experiment_id,sample_ordinal,turn_index,tag,note,updated_at')
        .limit(1);
      if (error) throw repositoryError(error);
      return toAnnotation(expectFirst<AnnotationRow>(data, 'annotation'));
    }

    const { data, error } = await this.db
      .from('annotations')
      .insert({
        experiment_id: input.experiment_id,
        sample_ordinal: input.sample_ordinal,
        turn_index: input.turn_index,
        tag: input.tag,
        note: input.note,
      })
      .select('experiment_id,sample_ordinal,turn_index,tag,note,updated_at')
      .limit(1);
    if (error) throw repositoryError(error);
    return toAnnotation(expectFirst<AnnotationRow>(data, 'annotation'));
  }

  async buildExportRows(experimentId: string): Promise<BatchLabExportRow[]> {
    const experiment = await this.getExperimentDetail(experimentId);
    const [samples, attempts, annotations] = await Promise.all([
      this.listSamplesForExport(experiment.sample_set_id),
      this.listAttemptsForExport(experiment.id),
      this.listAnnotations(experiment.id),
    ]);
    return samples.map((sample) =>
      batchLabExportRowSchema.parse({
        schema_version: BATCH_LAB_JSONL_SCHEMA_VERSION,
        experiment,
        sample,
        attempts: attempts
          .filter((attempt) => attempt.sample_ordinal === sample.ordinal)
          .map(({ sample_ordinal: _sampleOrdinal, ...attempt }) => attempt),
        annotations: annotations.filter(
          (annotation) =>
            annotation.sample_ordinal === null || annotation.sample_ordinal === sample.ordinal
        ),
      })
    );
  }

  async claimAttempts(workerId: string, limit: number): Promise<ExperimentAttemptRow[]> {
    const { data, error } = await this.db.rpc('claim_experiment_attempts', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: 120,
    });
    if (error) throw repositoryError(error);
    return (data ?? []) as ExperimentAttemptRow[];
  }

  async getExecutionContext(attempt: ExperimentAttemptRow): Promise<ExecutionContext> {
    const [experiment, sample, previousOutputs] = await Promise.all([
      this.getExperiment(attempt.experiment_id),
      this.getSample(attempt.sample_set_id, attempt.sample_ordinal),
      this.listPreviousOutputs(attempt),
    ]);
    const variant = experiment.variants.find((candidate) => candidate.key === attempt.variant_key);
    if (!variant) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR',
        'Batch Lab experiment variant was not found'
      );
    }
    return { experiment, variant, sample, previousOutputs };
  }

  async completeAttempt(input: CompleteAttemptInput): Promise<void> {
    const { error } = await this.db
      .from('experiment_attempts')
      .update({
        status: 'succeeded',
        generation_id: input.generationId,
        finish_reason: input.finishReason,
        raw_output: input.rawOutput,
        display_result_id: input.displayResultId,
        lease_expires_at: null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', input.attemptId);
    if (error) throw repositoryError(error);
  }

  async failAttempt(input: FailAttemptInput): Promise<void> {
    const status = input.retryable ? 'pending' : 'failed';
    const { error } = await this.db
      .from('experiment_attempts')
      .update({
        status,
        error_code: input.errorCode,
        error_message: input.errorMessage.slice(0, 500),
        lease_expires_at: null,
        completed_at: input.retryable ? null : new Date().toISOString(),
      })
      .eq('id', input.attemptId);
    if (error) throw repositoryError(error);
    if (!input.retryable) {
      await this.blockLaterAttempts(input.attempt);
    }
  }

  async refreshExperimentCounts(experimentId: string): Promise<BatchLabExperimentSummary> {
    const { data, error } = await this.db.rpc('refresh_experiment_counts', {
      p_experiment_id: experimentId,
    });
    if (error) throw repositoryError(error);
    return toExperiment(expectFirst<ExperimentRow>(data, 'experiment'));
  }

  private async getExperiment(id: string): Promise<BatchLabExperimentSummary> {
    return toExperiment(await this.getExperimentRow(id));
  }

  private async getExperimentRow(id: string): Promise<ExperimentRow> {
    const { data, error } = await this.db
      .from('experiments')
      .select(EXPERIMENT_SELECT)
      .eq('id', id)
      .limit(1);
    if (error) throw repositoryError(error);
    const row = ((data ?? []) as ExperimentRow[])[0];
    if (!row) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_EXPERIMENT_NOT_FOUND',
        'Batch Lab experiment was not found'
      );
    }
    return row;
  }

  private async getSample(sampleSetId: string, ordinal: number): Promise<ExecutionSampleSnapshot> {
    const { data, error } = await this.db
      .from('sample_snapshots')
      .select('source_user_id,source_character_id,user_input,history,original_model')
      .eq('sample_set_id', sampleSetId)
      .eq('ordinal', ordinal)
      .limit(1);
    if (error) throw repositoryError(error);
    const row = ((data ?? []) as ExecutionSampleSnapshot[])[0];
    if (!row) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR',
        'Batch Lab sample snapshot was not found'
      );
    }
    return row;
  }

  private async listPreviousOutputs(attempt: ExperimentAttemptRow): Promise<string[]> {
    const { data, error } = await this.db
      .from('experiment_attempts')
      .select('turn_index,raw_output')
      .eq('experiment_id', attempt.experiment_id)
      .eq('sample_ordinal', attempt.sample_ordinal)
      .eq('variant_key', attempt.variant_key)
      .lt('turn_index', attempt.turn_index)
      .eq('status', 'succeeded')
      .order('turn_index');
    if (error) throw repositoryError(error);
    return ((data ?? []) as Array<{ raw_output: string | null }>)
      .map((row) => row.raw_output)
      .filter((value): value is string => typeof value === 'string');
  }

  private async updateExperimentLineage(
    experimentId: string,
    input: {
      kind: 'generation' | 'reuse_display';
      sourceExperimentId: string | null;
      generationSourceExperimentId: string | null;
    }
  ): Promise<void> {
    const { error } = await this.db
      .from('experiments')
      .update({
        kind: input.kind,
        source_experiment_id: input.sourceExperimentId,
        generation_source_experiment_id: input.generationSourceExperimentId,
      })
      .eq('id', experimentId);
    if (error) throw repositoryError(error);
  }

  private async findExperimentByIdempotency(
    idempotencyKey: string
  ): Promise<BatchLabExperimentSummary | null> {
    const { data, error } = await this.db
      .from('experiments')
      .select(EXPERIMENT_SELECT)
      .eq('idempotency_key', idempotencyKey)
      .limit(1);
    if (error) return null;
    const row = ((data ?? []) as ExperimentRow[])[0];
    return row ? toExperiment(row) : null;
  }

  private async findAnnotation(
    experimentId: string,
    sampleOrdinal: number | null,
    turnIndex: number | null
  ): Promise<BatchLabAnnotation | null> {
    let query = this.db
      .from('annotations')
      .select('experiment_id,sample_ordinal,turn_index,tag,note,updated_at')
      .eq('experiment_id', experimentId);
    query =
      sampleOrdinal === null
        ? query.is('sample_ordinal', null)
        : query.eq('sample_ordinal', sampleOrdinal);
    query = turnIndex === null ? query.is('turn_index', null) : query.eq('turn_index', turnIndex);
    const { data, error } = await query.limit(1);
    if (error) throw repositoryError(error);
    const row = ((data ?? []) as AnnotationRow[])[0];
    return row ? toAnnotation(row) : null;
  }

  private async listAnnotations(experimentId: string): Promise<BatchLabAnnotation[]> {
    const { data, error } = await this.db
      .from('annotations')
      .select('experiment_id,sample_ordinal,turn_index,tag,note,updated_at')
      .eq('experiment_id', experimentId);
    if (error) throw repositoryError(error);
    return ((data ?? []) as AnnotationRow[]).map(toAnnotation);
  }

  private async listSamplesForExport(sampleSetId: string) {
    const { data, error } = await this.db
      .from('sample_snapshots')
      .select(
        'ordinal,source_history_id,source_session_id,source_user_id,source_character_id,turn_index,revision,user_input,original_assistant_reply,original_model,history,character_snapshot,dynamic_input_snapshot,restoration_strategy'
      )
      .eq('sample_set_id', sampleSetId)
      .order('ordinal');
    if (error) throw repositoryError(error);
    return ((data ?? []) as Required<ExecutionSampleSnapshot>[]).map((sample) => ({
      ordinal: sample.ordinal,
      source_history_id: sample.source_history_id,
      source_session_id: sample.source_session_id,
      source_user_id: sample.source_user_id,
      source_character_id: sample.source_character_id,
      turn_index: sample.turn_index,
      revision: sample.revision,
      user_input: sample.user_input,
      original_assistant_reply: sample.original_assistant_reply,
      original_model: sample.original_model,
      history: sample.history,
      character_snapshot: sample.character_snapshot,
      dynamic_input_snapshot: sample.dynamic_input_snapshot,
      restoration_strategy: sample.restoration_strategy,
    }));
  }

  private async listAttemptsForExport(experimentId: string): Promise<ExportAttemptWithSample[]> {
    const { data, error } = await this.db
      .from('experiment_attempts')
      .select(
        'id,sample_ordinal,variant_key,turn_index,status,generation_id,finish_reason,raw_output,display_result_id,error_code,error_message'
      )
      .eq('experiment_id', experimentId)
      .order('sample_ordinal')
      .order('variant_key')
      .order('turn_index');
    if (error) throw repositoryError(error);
    return ((data ?? []) as AttemptExportRow[]).map((row) => ({
      sample_ordinal: row.sample_ordinal,
      attempt_id: row.id,
      variant_key: row.variant_key,
      turn_index: row.turn_index,
      status: row.status,
      generation_id: row.generation_id,
      finish_reason: row.finish_reason,
      raw_output: row.raw_output,
      display_result_id: row.display_result_id,
      error_code: row.error_code,
      error_message: row.error_message,
    }));
  }

  private async blockLaterAttempts(attempt: ExperimentAttemptRow): Promise<void> {
    const { error } = await this.db
      .from('experiment_attempts')
      .update({
        status: 'blocked',
        error_code: 'BATCH_LAB_EXPERIMENT_STATE_CONFLICT',
        error_message: 'blocked by previous failed turn',
        completed_at: new Date().toISOString(),
      })
      .eq('experiment_id', attempt.experiment_id)
      .eq('sample_ordinal', attempt.sample_ordinal)
      .eq('variant_key', attempt.variant_key)
      .gt('turn_index', attempt.turn_index)
      .eq('status', 'pending');
    if (error) throw repositoryError(error);
  }
}

const EXPERIMENT_SELECT =
  'id,name,source_environment,sample_set_id,status,variants,total_attempts,completed_attempts,failed_attempts,kind,source_experiment_id,generation_source_experiment_id,created_at,started_at,completed_at';

export function toExperiment(row: ExperimentRow): BatchLabExperimentSummary {
  return batchLabExperimentSummarySchema.parse({
    id: row.id,
    name: row.name,
    sample_set_id: row.sample_set_id,
    source_environment: row.source_environment,
    status: row.status,
    variants: row.variants,
    total_attempts: row.total_attempts,
    completed_attempts: row.completed_attempts,
    failed_attempts: row.failed_attempts,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  });
}

export function toExperimentDetail(row: ExperimentRow): BatchLabExperimentDetail {
  return batchLabExperimentDetailSchema.parse({
    ...toExperiment(row),
    lineage: {
      kind: row.kind ?? 'generation',
      source_experiment_id: row.source_experiment_id ?? null,
      generation_source_experiment_id: row.generation_source_experiment_id ?? null,
    },
  });
}

interface AnnotationRow {
  experiment_id: string;
  sample_ordinal: number | null;
  turn_index: number | null;
  tag: string | null;
  note: string | null;
  updated_at: string;
}

function toAnnotation(row: AnnotationRow): BatchLabAnnotation {
  return batchLabAnnotationSchema.parse(row);
}

interface AttemptExportRow extends Omit<BatchLabExportAttempt, 'attempt_id'> {
  id: string;
  sample_ordinal: number;
}

interface ExportAttemptWithSample extends BatchLabExportAttempt {
  sample_ordinal: number;
}

function expectFirst<T>(value: unknown, label: string): T {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BatchLabRepositoryError(
      'BATCH_LAB_PROTOCOL_ERROR',
      `Batch Lab ${label} operation returned no row`
    );
  }
  return value[0] as T;
}
