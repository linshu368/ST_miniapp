import {
  batchLabDisplayResultSchema,
  batchLabProcessorConfigSchema,
  batchLabProcessorVersionSchema,
  type BatchLabDisplayResult,
  type BatchLabDisplayResultStatus,
  type BatchLabErrorCode,
  type BatchLabProcessorConfig,
  type BatchLabProcessorProtocol,
  type BatchLabProcessorVersion,
} from '@miniapp/shared';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import { BatchLabRepositoryError, repositoryError } from './BatchLabSampleRepository.js';

interface ProcessorVersionRow {
  id: string;
  name: string;
  protocol: BatchLabProcessorProtocol;
  config: unknown;
  digest: string;
  created_at: string;
}

interface DisplayResultRow {
  id: string;
  processor_version_id: string;
  processor_digest: string;
  status: BatchLabDisplayResultStatus;
  error_code: BatchLabErrorCode | null;
  match_count: number;
  input_text: string;
  output_text: string;
  sanitized_html: string;
  renderer_protocol: 'batch_lab_html_v1';
  renderer_version: 1;
  created_at: string;
}

export interface CreateProcessorVersionInput {
  name: string;
  config: BatchLabProcessorConfig;
  digest: string;
}

export interface CreateDisplayResultInput extends Omit<BatchLabDisplayResult, 'id' | 'created_at'> {
  input_digest: string;
  source_kind?: 'preview' | 'experiment_attempt';
  source_id?: string | null;
  idempotency_key?: string | null;
}

export class BatchLabProcessorRepository {
  constructor(private readonly db: DomainDb = getDomainDb('batch_lab')) {}

  async listProcessorVersions(limit = 50): Promise<BatchLabProcessorVersion[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const { data, error } = await this.db
      .from('processor_versions')
      .select('id,name,protocol,config,digest,created_at')
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error) throw repositoryError(error);
    return ((data ?? []) as ProcessorVersionRow[]).map(toProcessorVersion);
  }

  async getProcessorVersion(id: string): Promise<BatchLabProcessorVersion> {
    const { data, error } = await this.db
      .from('processor_versions')
      .select('id,name,protocol,config,digest,created_at')
      .eq('id', id)
      .limit(1);
    if (error) throw repositoryError(error);
    const row = ((data ?? []) as ProcessorVersionRow[])[0];
    if (!row) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_PROCESSOR_NOT_FOUND',
        'Batch Lab processor version was not found'
      );
    }
    return toProcessorVersion(row);
  }

  async createProcessorVersion(
    input: CreateProcessorVersionInput
  ): Promise<BatchLabProcessorVersion> {
    const row = {
      name: input.name,
      protocol: input.config.protocol,
      config: input.config,
      digest: input.digest,
    };
    const { data, error } = await this.db
      .from('processor_versions')
      .insert(row)
      .select('id,name,protocol,config,digest,created_at')
      .limit(1);
    if (error) {
      const existing = await this.findProcessorVersionByDigest(input.digest);
      if (existing) return existing;
      throw repositoryError(error);
    }
    return toProcessorVersion(expectFirst<ProcessorVersionRow>(data, 'processor version'));
  }

  async createDisplayResult(input: CreateDisplayResultInput): Promise<BatchLabDisplayResult> {
    const { data, error } = await this.db
      .from('display_results')
      .insert({
        processor_version_id: input.processor_version_id,
        processor_digest: input.processor_digest,
        source_kind: input.source_kind ?? 'preview',
        source_id: input.source_id ?? null,
        idempotency_key: input.idempotency_key ?? null,
        status: input.status,
        error_code: input.error_code,
        match_count: input.match_count,
        input_digest: input.input_digest,
        input_text: input.input_text,
        output_text: input.output_text,
        sanitized_html: input.sanitized_html,
        renderer_protocol: input.renderer.protocol,
        renderer_version: input.renderer.version,
      })
      .select(
        'id,processor_version_id,processor_digest,status,error_code,match_count,input_text,output_text,sanitized_html,renderer_protocol,renderer_version,created_at'
      )
      .limit(1);
    if (error) throw repositoryError(error);
    return toDisplayResult(expectFirst<DisplayResultRow>(data, 'display result'));
  }

  private async findProcessorVersionByDigest(
    digest: string
  ): Promise<BatchLabProcessorVersion | null> {
    const { data, error } = await this.db
      .from('processor_versions')
      .select('id,name,protocol,config,digest,created_at')
      .eq('digest', digest)
      .limit(1);
    if (error) return null;
    const row = ((data ?? []) as ProcessorVersionRow[])[0];
    return row ? toProcessorVersion(row) : null;
  }
}

export function toProcessorVersion(row: ProcessorVersionRow): BatchLabProcessorVersion {
  return batchLabProcessorVersionSchema.parse({
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    config: batchLabProcessorConfigSchema.parse(row.config),
    digest: row.digest,
    created_at: row.created_at,
  });
}

export function toDisplayResult(row: DisplayResultRow): BatchLabDisplayResult {
  return batchLabDisplayResultSchema.parse({
    id: row.id,
    processor_version_id: row.processor_version_id,
    processor_digest: row.processor_digest,
    status: row.status,
    error_code: row.error_code,
    match_count: row.match_count,
    input_text: row.input_text,
    output_text: row.output_text,
    sanitized_html: row.sanitized_html,
    renderer: {
      protocol: row.renderer_protocol,
      version: row.renderer_version,
    },
    created_at: row.created_at,
  });
}

function expectFirst<T>(value: unknown, label: string): T {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BatchLabRepositoryError(
      'BATCH_LAB_PROTOCOL_ERROR',
      `Batch Lab ${label} insert returned no row`
    );
  }
  return value[0] as T;
}
