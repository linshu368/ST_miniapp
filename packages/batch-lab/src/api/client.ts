import {
  batchLabAnnotationResponseSchema,
  batchLabCopyExperimentRequestSchema,
  batchLabCreateExperimentRequestSchema,
  batchLabCreateProcessorVersionRequestSchema,
  batchLabCreateSampleSetRequestSchema,
  batchLabContextResponseSchema,
  batchLabErrorResponseSchema,
  batchLabExperimentDetailResponseSchema,
  batchLabExperimentListResponseSchema,
  batchLabExperimentResponseSchema,
  batchLabProcessorPreviewRequestSchema,
  batchLabProcessorPreviewResponseSchema,
  batchLabProcessorVersionListResponseSchema,
  batchLabProcessorVersionResponseSchema,
  batchLabPreviewRequestSchema,
  batchLabPreviewResponseSchema,
  batchLabReuseDisplayExperimentRequestSchema,
  batchLabRunWorkerRequestSchema,
  batchLabRunWorkerResponseSchema,
  batchLabSampleSetListResponseSchema,
  batchLabSampleSetResponseSchema,
  batchLabSqlTemplateListResponseSchema,
  batchLabStartExperimentRequestSchema,
  batchLabUpsertAnnotationRequestSchema,
  type BatchLabAnnotation,
  type BatchLabCopyExperimentRequest,
  type BatchLabContext,
  type BatchLabCreateExperimentRequest,
  type BatchLabCreateProcessorVersionRequest,
  type BatchLabCreateSampleSetRequest,
  type BatchLabDisplayResult,
  type BatchLabExperimentDetail,
  type BatchLabExperimentSummary,
  type BatchLabProcessorPreviewRequest,
  type BatchLabProcessorVersion,
  type BatchLabPreview,
  type BatchLabPreviewRequest,
  type BatchLabReuseDisplayExperimentRequest,
  type BatchLabRunWorkerRequest,
  type BatchLabRunWorkerResult,
  type BatchLabSampleSet,
  type BatchLabSqlTemplate,
  type BatchLabStartExperimentRequest,
  type BatchLabUpsertAnnotationRequest,
} from '@miniapp/shared';
import type { ZodType } from 'zod';

const DEFAULT_TIMEOUT_MS = 10_000;

export type BatchLabClientErrorKind =
  | 'configuration'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'protocol';

export class BatchLabClientError extends Error {
  constructor(
    readonly kind: BatchLabClientErrorKind,
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'BatchLabClientError';
  }
}

function apiBase(): string {
  const value = import.meta.env.VITE_BATCH_LAB_API_URL?.trim();
  if (!value) throw new BatchLabClientError('configuration', '缺少 VITE_BATCH_LAB_API_URL');
  return value.replace(/\/$/, '');
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `batch-lab-${Date.now()}-${Math.random()}`;
}

export async function request<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestInit & { timeoutMs?: number; apiBaseUrl?: string } = {}
): Promise<T> {
  if (options.signal?.aborted) {
    throw new BatchLabClientError('cancelled', '请求已取消', 'BATCH_LAB_REQUEST_CANCELLED');
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-Request-Id', requestId());
    const response = await fetch(`${options.apiBaseUrl?.replace(/\/$/, '') ?? apiBase()}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = batchLabErrorResponseSchema.safeParse(payload);
      throw new BatchLabClientError(
        'http',
        parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
        parsed.success ? parsed.data.error.code : undefined,
        response.status
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new BatchLabClientError(
        'protocol',
        'Backend 返回了无效响应',
        'BATCH_LAB_PROTOCOL_ERROR'
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof BatchLabClientError) throw error;
    if (controller.signal.aborted) {
      throw new BatchLabClientError(
        timedOut ? 'timeout' : 'cancelled',
        timedOut ? '请求超时' : '请求已取消',
        timedOut ? 'BATCH_LAB_TIMEOUT' : 'BATCH_LAB_REQUEST_CANCELLED'
      );
    }
    throw new BatchLabClientError(
      'network',
      error instanceof Error ? error.message : '网络请求失败',
      'BATCH_LAB_NETWORK_ERROR'
    );
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function getBatchLabContext(signal?: AbortSignal): Promise<BatchLabContext> {
  const response = await request('/api/batch-lab/context', batchLabContextResponseSchema, {
    signal,
  });
  return response.data;
}

export async function listBatchLabSqlTemplates(
  signal?: AbortSignal
): Promise<BatchLabSqlTemplate[]> {
  const response = await request(
    '/api/batch-lab/sql-templates',
    batchLabSqlTemplateListResponseSchema,
    {
      signal,
    }
  );
  return response.data.items;
}

export async function listBatchLabProcessors(
  signal?: AbortSignal
): Promise<BatchLabProcessorVersion[]> {
  const response = await request(
    '/api/batch-lab/processors',
    batchLabProcessorVersionListResponseSchema,
    { signal }
  );
  return response.data.items;
}

export async function createBatchLabProcessor(
  input: BatchLabCreateProcessorVersionRequest,
  signal?: AbortSignal
): Promise<BatchLabProcessorVersion> {
  const body = batchLabCreateProcessorVersionRequestSchema.parse(input);
  const response = await request(
    '/api/batch-lab/processors',
    batchLabProcessorVersionResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }
  );
  return response.data;
}

export async function previewBatchLabProcessor(
  input: BatchLabProcessorPreviewRequest,
  signal?: AbortSignal
): Promise<BatchLabDisplayResult> {
  const body = batchLabProcessorPreviewRequestSchema.parse(input);
  const response = await request(
    '/api/batch-lab/processors/preview',
    batchLabProcessorPreviewResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: 30_000,
    }
  );
  return response.data;
}

export async function createBatchLabPreview(
  input: BatchLabPreviewRequest,
  signal?: AbortSignal
): Promise<BatchLabPreview> {
  const body = batchLabPreviewRequestSchema.parse(input);
  const response = await request('/api/batch-lab/sample-previews', batchLabPreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    timeoutMs: 30_000,
  });
  return response.data;
}

export async function createBatchLabSampleSet(
  input: BatchLabCreateSampleSetRequest,
  signal?: AbortSignal
): Promise<BatchLabSampleSet> {
  const body = batchLabCreateSampleSetRequestSchema.parse(input);
  const response = await request('/api/batch-lab/sample-sets', batchLabSampleSetResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return response.data;
}

export async function listBatchLabSampleSets(signal?: AbortSignal): Promise<BatchLabSampleSet[]> {
  const response = await request(
    '/api/batch-lab/sample-sets',
    batchLabSampleSetListResponseSchema,
    {
      signal,
    }
  );
  return response.data.items;
}

export async function listBatchLabExperiments(
  signal?: AbortSignal
): Promise<BatchLabExperimentSummary[]> {
  const response = await request(
    '/api/batch-lab/experiments',
    batchLabExperimentListResponseSchema,
    {
      signal,
    }
  );
  return response.data.items;
}

export async function createBatchLabExperiment(
  input: BatchLabCreateExperimentRequest,
  signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
  const body = batchLabCreateExperimentRequestSchema.parse(input);
  const response = await request('/api/batch-lab/experiments', batchLabExperimentResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return response.data;
}

export async function getBatchLabExperiment(
  experimentId: string,
  signal?: AbortSignal
): Promise<BatchLabExperimentDetail> {
  const response = await request(
    `/api/batch-lab/experiments/${experimentId}`,
    batchLabExperimentDetailResponseSchema,
    { signal }
  );
  return response.data;
}

export async function copyBatchLabExperiment(
  input: BatchLabCopyExperimentRequest,
  signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
  const body = batchLabCopyExperimentRequestSchema.parse(input);
  const response = await request(
    `/api/batch-lab/experiments/${body.source_experiment_id}/copy`,
    batchLabExperimentResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }
  );
  return response.data;
}

export async function createBatchLabReuseDisplayExperiment(
  input: BatchLabReuseDisplayExperimentRequest,
  signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
  const body = batchLabReuseDisplayExperimentRequestSchema.parse(input);
  const response = await request(
    `/api/batch-lab/experiments/${body.source_experiment_id}/reuse-display`,
    batchLabExperimentResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }
  );
  return response.data;
}

export async function upsertBatchLabAnnotation(
  input: BatchLabUpsertAnnotationRequest,
  signal?: AbortSignal
): Promise<BatchLabAnnotation> {
  const body = batchLabUpsertAnnotationRequestSchema.parse(input);
  const response = await request(
    `/api/batch-lab/experiments/${body.experiment_id}/annotations`,
    batchLabAnnotationResponseSchema,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }
  );
  return response.data;
}

export async function downloadBatchLabExperimentJsonl(
  experimentId: string,
  signal?: AbortSignal
): Promise<Blob> {
  const response = await fetch(
    `${apiBase()}/api/batch-lab/experiments/${experimentId}/export.jsonl`,
    {
      headers: { Accept: 'application/x-ndjson', 'X-Request-Id': requestId() },
      signal,
    }
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = batchLabErrorResponseSchema.safeParse(payload);
    throw new BatchLabClientError(
      'http',
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
      parsed.success ? parsed.data.error.code : undefined,
      response.status
    );
  }
  return response.blob();
}

export async function startBatchLabExperiment(
  input: BatchLabStartExperimentRequest,
  signal?: AbortSignal
): Promise<BatchLabExperimentSummary> {
  const body = batchLabStartExperimentRequestSchema.parse(input);
  const response = await request(
    '/api/batch-lab/experiments/start',
    batchLabExperimentResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }
  );
  return response.data;
}

export async function runBatchLabWorkerOnce(
  input: BatchLabRunWorkerRequest,
  signal?: AbortSignal
): Promise<BatchLabRunWorkerResult> {
  const body = batchLabRunWorkerRequestSchema.parse(input);
  const response = await request(
    '/api/batch-lab/worker/run-once',
    batchLabRunWorkerResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: 60_000,
    }
  );
  return response.data;
}
