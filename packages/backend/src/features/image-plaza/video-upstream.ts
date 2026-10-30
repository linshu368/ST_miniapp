import { config } from '../../platform/config.js';
import { veniceFetch } from '../../platform/venice-http.js';

export interface VideoPlazaProviderErrorSummary {
  status: number;
  type: string | null;
  message: string | null;
  fields: string[];
}

export class VideoPlazaUpstreamError extends Error {
  constructor(
    readonly code: string,
    readonly disposition: 'refund' | 'unknown' | 'retry',
    options?: ErrorOptions,
    readonly upstream?: VideoPlazaProviderErrorSummary
  ) {
    super(code, options);
    this.name = 'VideoPlazaUpstreamError';
  }
}

export async function queueVideo(input: {
  providerModelId: string;
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string | null;
  audio: boolean;
  inputMode: 't2v' | 'i2v' | 'r2v';
  referenceUrl: string | null;
}): Promise<{ queueId: string; downloadUrl: string | null }> {
  requireProvider();
  const payload: Record<string, unknown> = {
    model: input.providerModelId,
    prompt: input.prompt,
    duration: `${input.duration}s`,
    resolution: input.resolution,
  };
  // Venice defaults audio to true. Fixed-audio models reject this field even when its value is true;
  // only the configurable opt-out needs to cross the provider boundary.
  if (!input.audio) payload.audio = false;
  // I2V providers derive output shape from the first frame. Some Venice I2V models reject the
  // otherwise valid product-level aspect ratio, so only modes that advertise ratio control send it.
  if (input.aspectRatio && input.inputMode !== 'i2v') payload.aspect_ratio = input.aspectRatio;
  if (input.inputMode === 'i2v' && input.referenceUrl) payload.image_url = input.referenceUrl;
  if (input.inputMode === 'r2v' && input.referenceUrl)
    payload.reference_image_urls = [input.referenceUrl];

  let response: Response;
  try {
    response = await veniceFetch(`${baseUrl()}/video/queue`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.imagePlaza.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.imagePlaza.timeoutMs),
    });
  } catch (cause) {
    throw new VideoPlazaUpstreamError('video_provider_submit_unknown', 'unknown', { cause });
  }
  if (!response.ok)
    throw await classifyResponse(response, 'queue', [input.prompt, input.referenceUrl]);
  const parsed = parseQueueResponse(await response.json().catch(() => null));
  if (!parsed) throw new VideoPlazaUpstreamError('video_provider_submit_unknown', 'unknown');
  return { queueId: parsed.queueId, downloadUrl: parsed.downloadUrl };
}

export async function retrieveVideo(input: { providerModelId: string; queueId: string }): Promise<
  | {
      kind: 'processing';
      averageExecutionTimeMs: number | null;
      executionDurationMs: number | null;
    }
  | { kind: 'completed'; bytes: Buffer | null; downloadUrl: string | null }
> {
  requireProvider();
  let response: Response;
  try {
    response = await veniceFetch(`${baseUrl()}/video/retrieve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.imagePlaza.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.providerModelId,
        queue_id: input.queueId,
        delete_media_on_completion: false,
      }),
      signal: AbortSignal.timeout(config.imagePlaza.timeoutMs),
    });
  } catch (cause) {
    throw new VideoPlazaUpstreamError('video_provider_poll_retry', 'retry', { cause });
  }
  if (!response.ok) throw await classifyResponse(response, 'retrieve');
  if ((response.headers.get('content-type') ?? '').toLowerCase().includes('video/mp4')) {
    return { kind: 'completed', bytes: await boundedBytes(response), downloadUrl: null };
  }
  const parsed = parseRetrieveResponse(await response.json().catch(() => null));
  if (!parsed) throw new VideoPlazaUpstreamError('video_provider_poll_retry', 'retry');
  return parsed.status === 'PROCESSING'
    ? {
        kind: 'processing',
        averageExecutionTimeMs: parsed.averageExecutionTimeMs,
        executionDurationMs: parsed.executionDurationMs,
      }
    : { kind: 'completed', bytes: null, downloadUrl: parsed.downloadUrl };
}

export function recommendedVideoPollDelayMs(input: {
  pollCount: number;
  averageExecutionTimeMs: number | null;
  executionDurationMs: number | null;
}): number {
  const average = input.averageExecutionTimeMs;
  const elapsed = input.executionDurationMs;
  if (average !== null && elapsed !== null && average > 0 && elapsed >= 0) {
    const remaining = Math.max(0, average - elapsed);
    return Math.min(10_000, Math.max(5_000, Math.round(remaining / 4)));
  }
  return Math.min(10_000, Math.round(5_000 * 1.35 ** Math.min(Math.max(input.pollCount, 0), 4)));
}

export async function downloadVideo(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('video_provider_download_url_invalid');
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(parsed, {
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        throw new VideoPlazaUpstreamError(`video_provider_download_${response.status}`, 'retry');
      return await boundedBytes(response);
    } catch (err) {
      lastError = err;
      if (attempt < 2) await delay(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('video_provider_download_failed');
}

export async function completeVideo(providerModelId: string, queueId: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await veniceFetch(`${baseUrl()}/video/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.imagePlaza.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: providerModelId, queue_id: queueId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok || response.status === 404) return;
      throw new VideoPlazaUpstreamError(`video_provider_complete_${response.status}`, 'retry');
    } catch (err) {
      lastError = err;
      if (attempt < 2) await delay(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('video_provider_complete_failed');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function classifyResponse(
  response: Response,
  phase: 'queue' | 'retrieve',
  sensitiveValues: Array<string | null> = []
): Promise<VideoPlazaUpstreamError> {
  const body = await response.json().catch(() => null);
  return classify(
    response.status,
    phase,
    summarizeProviderError(response.status, body, sensitiveValues)
  );
}

function classify(
  status: number,
  phase: 'queue' | 'retrieve',
  upstream?: VideoPlazaProviderErrorSummary
): VideoPlazaUpstreamError {
  if (status === 422)
    return new VideoPlazaUpstreamError('video_moderation_rejected', 'refund', undefined, upstream);
  if (phase === 'retrieve' && status === 404)
    return new VideoPlazaUpstreamError(
      'video_provider_media_expired',
      'refund',
      undefined,
      upstream
    );
  if ([400, 402, 409, 413].includes(status))
    return new VideoPlazaUpstreamError(
      `video_provider_http_${status}`,
      'refund',
      undefined,
      upstream
    );
  if ([429, 500, 503].includes(status))
    return new VideoPlazaUpstreamError(
      `video_provider_http_${status}`,
      'retry',
      undefined,
      upstream
    );
  return new VideoPlazaUpstreamError(
    `video_provider_http_${status}`,
    phase === 'queue' ? 'unknown' : 'retry',
    undefined,
    upstream
  );
}

function summarizeProviderError(
  status: number,
  value: unknown,
  sensitiveValues: Array<string | null>
): VideoPlazaProviderErrorSummary {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const error = row?.error;
  const errorRow = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const type = safeProviderType(errorRow?.type ?? errorRow?.code ?? row?.type ?? row?.code);
  const rawMessage =
    typeof error === 'string'
      ? error
      : (errorRow?.message ?? row?.message ?? (typeof value === 'string' ? value : null));
  return {
    status,
    type,
    message: safeProviderMessage(rawMessage, sensitiveValues),
    fields: collectValidationFields(row?.details ?? errorRow?.details),
  };
}

function safeProviderType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, 80);
  return /^[a-zA-Z0-9_.:-]+$/.test(normalized) ? normalized : null;
}

function safeProviderMessage(value: unknown, sensitiveValues: Array<string | null>): string | null {
  if (typeof value !== 'string') return null;
  let sanitized = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive) sanitized = sanitized.replaceAll(sensitive, '[redacted]');
  }
  sanitized = sanitized
    .replace(/data:[^\s"']+/gi, '[data-url]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return sanitized || null;
}

function collectValidationFields(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const fields = new Set<string>();
  const visit = (current: unknown, path: string[], depth: number): void => {
    if (!current || typeof current !== 'object' || depth > 5 || fields.size >= 12) return;
    for (const [key, child] of Object.entries(current)) {
      if (key === '_errors') {
        if (Array.isArray(child) && child.length > 0 && path.length > 0)
          fields.add(path.join('.').slice(0, 120));
        continue;
      }
      visit(child, [...path, key], depth + 1);
    }
  };
  visit(value, [], 0);
  return [...fields];
}

async function boundedBytes(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > 200 * 1024 * 1024) throw new Error('video_plaza_asset_size_invalid');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > 200 * 1024 * 1024)
    throw new Error('video_plaza_asset_size_invalid');
  return bytes;
}

function requireProvider(): void {
  if (!config.imagePlaza.apiKey)
    throw new VideoPlazaUpstreamError('video_provider_unavailable', 'refund');
}

function baseUrl(): string {
  return config.imagePlaza.baseUrl.replace(/\/$/, '');
}

function parseQueueResponse(
  value: unknown
): { queueId: string; downloadUrl: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { queue_id?: unknown; download_url?: unknown };
  if (typeof row.queue_id !== 'string' || row.queue_id.length === 0) return null;
  if (row.download_url !== undefined && !isHttpsUrl(row.download_url)) return null;
  return {
    queueId: row.queue_id,
    downloadUrl: typeof row.download_url === 'string' ? row.download_url : null,
  };
}

function parseRetrieveResponse(value: unknown): {
  status: 'PROCESSING' | 'COMPLETED';
  downloadUrl: string | null;
  averageExecutionTimeMs: number | null;
  executionDurationMs: number | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    status?: unknown;
    download_url?: unknown;
    average_execution_time?: unknown;
    execution_duration?: unknown;
  };
  if (row.status !== 'PROCESSING' && row.status !== 'COMPLETED') return null;
  if (row.download_url !== undefined && !isHttpsUrl(row.download_url)) return null;
  return {
    status: row.status,
    downloadUrl: typeof row.download_url === 'string' ? row.download_url : null,
    averageExecutionTimeMs: nonNegativeNumber(row.average_execution_time),
    executionDurationMs: nonNegativeNumber(row.execution_duration),
  };
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
