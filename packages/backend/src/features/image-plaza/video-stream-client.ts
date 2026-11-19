import { z } from 'zod';
import { getVideoStreamConfig } from '../../platform/runtime-config.js';
import { clientFetch } from '../../platform/observability/fetch.js';

export class VideoStreamError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly outcomeUnknown = false,
    readonly retryAfterMs = 0
  ) {
    super(code);
  }
}

export function requireVideoStreamConfig() {
  const config = getVideoStreamConfig();
  if (!config) throw new VideoStreamError('video_stream_provider_unavailable');
  return config;
}

export const StreamVideoSchema = z.object({
  uid: z.string().regex(/^[a-f0-9]{32}$/),
  requireSignedURLs: z.boolean(),
  readyToStream: z.boolean(),
  status: z.object({ state: z.string(), pctComplete: z.string().optional() }),
  input: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
  duration: z.number().nullable().optional(),
});

/** Reads include the response body within the same deadline and allocation limit. */
export async function readStreamBody(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new VideoStreamError('video_stream_empty_response', true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new VideoStreamError('video_stream_response_too_large');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function streamRequest(path: string, init: RequestInit = {}) {
  const config = requireVideoStreamConfig();
  const response = await clientFetch('video.delivery.management', 'cloudflare')(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream${path}`,
    {
      ...init,
      redirect: 'error',
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    }
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new VideoStreamError(
      `video_stream_http_${response.status}`,
      response.status === 429 || response.status >= 500,
      false,
      retryAfterMs(response)
    );
  }
  const body = JSON.parse((await readStreamBody(response, 128 * 1024)).toString()) as {
    success?: boolean;
    result?: unknown;
  };
  if (body.success !== true) throw new VideoStreamError('video_stream_api_failed', true);
  return body.result;
}

export async function getStreamVideo(uid: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{32}$/.test(uid)) throw new VideoStreamError('video_stream_uid_invalid');
  return StreamVideoSchema.parse(await streamRequest(`/${uid}`, { signal }));
}

export async function deleteStreamVideo(uid: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(uid)) throw new VideoStreamError('video_stream_uid_invalid');
  const config = requireVideoStreamConfig();
  const response = await clientFetch('video.delivery.cleanup', 'cloudflare')(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${uid}`,
    {
      method: 'DELETE',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.apiToken}` },
    }
  );
  await response.body?.cancel();
  if (!response.ok && response.status !== 404)
    throw new VideoStreamError('video_stream_cleanup_failed', true);
}

export function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(3_600_000, milliseconds)) : 0;
}
