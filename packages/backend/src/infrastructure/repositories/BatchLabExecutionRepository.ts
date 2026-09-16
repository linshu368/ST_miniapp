import {
  batchLabExperimentSummarySchema,
  type BatchLabCreateExperimentRequest,
  type BatchLabExperimentSummary,
  type BatchLabExperimentVariant,
  type BatchLabStartExperimentRequest,
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
}

export interface ExecutionSampleSnapshot {
  source_user_id: string;
  source_character_id: string;
  user_input: string;
  history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  original_model: string;
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
    const { data, error } = await this.db
      .from('experiments')
      .select(
        'id,name,source_environment,sample_set_id,status,variants,total_attempts,completed_attempts,failed_attempts,created_at,started_at,completed_at'
      )
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
    return toExperiment(row);
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

function expectFirst<T>(value: unknown, label: string): T {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BatchLabRepositoryError(
      'BATCH_LAB_PROTOCOL_ERROR',
      `Batch Lab ${label} operation returned no row`
    );
  }
  return value[0] as T;
}
