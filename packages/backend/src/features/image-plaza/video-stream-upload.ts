import { VIDEO_PLAZA_MAX_FILE_BYTES } from '@miniapp/shared';
import { createHash } from 'node:crypto';
import { clientFetch } from '../../platform/observability/fetch.js';
import { requireVideoStreamConfig, retryAfterMs, VideoStreamError } from './video-stream-client.js';

export interface StreamUploadSession {
  uid: string;
  uploadUrl: string;
  byteSize: number;
  sha256: string;
}
const CHUNK_BYTES = 5 * 1024 * 1024;

/** A saved capability is only ever sent to Stream's TUS endpoint, without API credentials. */
export function assertStreamUploadUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['upload.videodelivery.net', 'upload.cloudflarestream.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new VideoStreamError('video_stream_upload_url_invalid');
  return url.href;
}

export async function createStreamUpload(
  bytes: Buffer,
  name: string,
  maxDurationSeconds = 300
): Promise<StreamUploadSession> {
  if (
    !bytes.length ||
    bytes.length > VIDEO_PLAZA_MAX_FILE_BYTES ||
    bytes.toString('ascii', 4, 8) !== 'ftyp'
  )
    throw new VideoStreamError('video_stream_source_invalid');
  const config = requireVideoStreamConfig();
  let response: Response;
  try {
    response = await clientFetch('video.delivery.create', 'cloudflare')(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream?direct_user=true`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(bytes.length),
          'Upload-Metadata': `name ${Buffer.from(`${config.environment}-plaza-${name}`).toString('base64')},requiresignedurls,maxDurationSeconds ${Buffer.from(String(Math.min(300, Math.max(1, Math.ceil(maxDurationSeconds))))).toString('base64')}`,
        },
      }
    );
  } catch {
    // Creation has no idempotency key. A lost response requires reconciliation, never another POST.
    throw new VideoStreamError('video_stream_create_unknown', false, true);
  }
  if (response.status !== 201) {
    await response.body?.cancel();
    throw new VideoStreamError(
      `video_stream_create_${response.status}`,
      response.status === 429,
      response.status >= 500,
      retryAfterMs(response)
    );
  }
  const uid = response.headers.get('stream-media-id') ?? '';
  const uploadUrl = response.headers.get('location') ?? '';
  await response.body?.cancel();
  try {
    if (!/^[a-f0-9]{32}$/.test(uid)) throw new Error('invalid_uid');
    return {
      uid,
      uploadUrl: assertStreamUploadUrl(uploadUrl),
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new VideoStreamError('video_stream_create_unknown', false, true);
  }
}

/** One bounded chunk per lease; HEAD resolves a lost PATCH response on the next round. */
export async function uploadStreamChunk(
  session: StreamUploadSession,
  bytes: Buffer
): Promise<boolean> {
  if (
    bytes.length !== session.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== session.sha256
  )
    throw new VideoStreamError('video_stream_source_changed', false, true);
  const url = assertStreamUploadUrl(session.uploadUrl);
  const fetch = clientFetch('video.delivery.upload', 'cloudflare');
  const head = await fetch(url, {
    method: 'HEAD',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Tus-Resumable': '1.0.0' },
  });
  const offsetValue = head.headers.get('upload-offset');
  const lengthValue = head.headers.get('upload-length');
  await head.body?.cancel();
  if (!head.ok)
    throw new VideoStreamError(
      `video_stream_resume_${head.status}`,
      true,
      false,
      retryAfterMs(head)
    );
  const offset = offsetValue === null ? NaN : Number(offsetValue);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.length ||
    Number(lengthValue) !== bytes.length
  )
    throw new VideoStreamError('video_stream_offset_invalid', false, true);
  if (offset === bytes.length) return true;
  const end = Math.min(bytes.length, offset + CHUNK_BYTES);
  const response = await fetch(url, {
    method: 'PATCH',
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
    },
    body: new Uint8Array(bytes.subarray(offset, end)).buffer,
  });
  await response.body?.cancel();
  if (response.status !== 204)
    throw new VideoStreamError(
      `video_stream_upload_${response.status}`,
      true,
      false,
      retryAfterMs(response)
    );
  if (Number(response.headers.get('upload-offset')) !== end)
    throw new VideoStreamError('video_stream_patch_unknown', true);
  return end === bytes.length;
}
