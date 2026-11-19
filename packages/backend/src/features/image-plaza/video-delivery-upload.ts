import type { VideoDeliveryRepository, DeliveryJob } from './video-delivery-repository.js';
import { requireVideoStreamConfig, VideoStreamError } from './video-stream-client.js';
import { createStreamUpload, uploadStreamChunk } from './video-stream-upload.js';
import { downloadVideo, retrieveVideo } from './video-upstream.js';

/** The buffer lives for one bounded round, never across leases or processes. */
export async function uploadVideoDelivery(
  repository: VideoDeliveryRepository,
  job: DeliveryJob,
  attempt: Awaited<ReturnType<VideoDeliveryRepository['attempt']>>,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  if (!attempt.provider_request_id)
    throw new VideoStreamError('video_stream_source_missing', false, true);
  const result = await retrieveVideo({
    providerModelId: attempt.provider_model_id,
    queueId: attempt.provider_request_id,
    signal,
  });
  if (result.kind !== 'completed')
    throw new VideoStreamError('video_stream_source_not_ready', true);
  const bytes =
    result.bytes ?? (await downloadVideo(result.downloadUrl ?? attempt.download_url ?? '', signal));
  signal.throwIfAborted();
  let session =
    job.stream_uid && job.upload_url && job.source_sha256 && job.source_byte_size
      ? {
          uid: job.stream_uid,
          uploadUrl: job.upload_url,
          sha256: job.source_sha256,
          byteSize: job.source_byte_size,
        }
      : null;
  if (!session) {
    const config = requireVideoStreamConfig();
    await repository.checkpoint(job, {
      stage: 'creating',
      deadline_at: new Date(
        Date.parse(job.created_at) + config.encodeDeadlineSeconds * 1000
      ).toISOString(),
    });
    job.stage = 'creating';
    if (signal.aborted) {
      // The intent was saved but no POST was dispatched, so this case is safe to resume.
      await repository.checkpoint(job, { stage: 'queued' });
      job.stage = 'queued';
      signal.throwIfAborted();
    }
    try {
      // A cancellation before dispatch is known; a lost POST response remains unknown.
      signal.throwIfAborted();
      session = await createStreamUpload(bytes, attempt.id, attempt.duration_s + 3, signal);
    } catch (err) {
      if (err instanceof VideoStreamError && err.retryable && !err.outcomeUnknown) {
        await repository.checkpoint(job, { stage: 'queued' });
        job.stage = 'queued';
      }
      throw err;
    }
    await repository.saveSession(job, session);
    job.stage = 'uploading';
  }
  const burstStartedAt = performance.now();
  for (let chunks = 0; chunks < 4; chunks += 1) {
    if (chunks > 0 && performance.now() - burstStartedAt >= 20_000) break;
    signal.throwIfAborted();
    const done = await uploadStreamChunk(session, bytes, signal);
    // Fence every acknowledged chunk before starting another network operation.
    // HEAD remains authoritative if PATCH or this checkpoint loses its response.
    await repository.checkpoint(job, {
      stage: done ? 'encoding' : 'uploading',
      retry_count: 0,
      ...(done ? { upload_url: null } : {}),
    });
    job.stage = done ? 'encoding' : 'uploading';
    job.retry_count = 0;
    if (done) break;
  }
  await repository.checkpoint(job, {
    next_run_at: new Date(Date.now() + (job.stage === 'encoding' ? 5000 : 0)).toISOString(),
    lease_token: null,
    lease_expires_at: null,
  });
}
