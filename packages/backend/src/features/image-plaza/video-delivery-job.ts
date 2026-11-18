import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../platform/config.js';
import { withBusinessContext } from '../../platform/observability/context.js';
import { finishBackgroundOperation, runObservedJob } from '../../platform/observability/jobs.js';
import { observation } from '../../platform/observability/runtime.js';
import { VideoDeliveryRepository, type DeliveryJob } from './video-delivery-repository.js';
import {
  deleteStreamVideo,
  requireVideoStreamConfig,
  VideoStreamError,
} from './video-stream-client.js';
import { createStreamUpload, uploadStreamChunk } from './video-stream-upload.js';
import {
  stablePlazaPlaybackUrl,
  streamPoster,
  verifyStreamReady,
} from './video-stream-playback.js';
import { completeVideo, downloadVideo, retrieveVideo } from './video-upstream.js';
import { validatePlazaImage, uploadPlazaVideoAsset } from './storage.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startVideoDeliveryJob(log: FastifyBaseLogger) {
  if (timer || !config.imagePlaza.videoWorkerEnabled) return;
  const repository = new VideoDeliveryRepository();
  const tick = () =>
    runObservedJob('video_plaza_delivery', async () => {
      if (running) {
        finishBackgroundOperation('video_plaza_delivery', {
          outcome: 'skipped',
          outcome_known: true,
        });
        return;
      }
      running = true;
      try {
        requireVideoStreamConfig();

        const jobs = await repository.claim();
        await Promise.all(
          jobs.map((job) =>
            withBusinessContext(
              { business_module: 'image', attempt_id: job.attempt_id },
              async () => {
                try {
                  await deliver(repository, job, log);
                } catch (err) {
                  log.error(
                    { err, event: 'video_plaza.delivery_round_unknown' },
                    'Video delivery round requires reconciliation'
                  );
                }
              }
            )
          )
        );
        for (const asset of await repository.failedAssets()) {
          await deleteStreamVideo(asset.stream_uid);
          await repository.cleaned(asset.id);
        }
        await repository.prune();
        finishBackgroundOperation('video_plaza_delivery', {
          outcome: jobs.length ? 'succeeded' : 'skipped',
          outcome_known: true,
          count: jobs.length,
        });
      } catch (err) {
        finishBackgroundOperation('video_plaza_delivery', {
          outcome: 'failed',
          outcome_known: false,
          err,
        });
        log.error({ err, event: 'video_plaza.delivery_tick_failed' }, 'Video delivery tick failed');
      } finally {
        running = false;
      }
    });
  timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
}

export function stopVideoDeliveryJob() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

async function deliver(
  repository: VideoDeliveryRepository,
  job: DeliveryJob,
  log: FastifyBaseLogger
) {
  const attempt = await repository.attempt(job.attempt_id);
  await withBusinessContext(
    {
      business_module: 'image',
      user_id: attempt.user_id,
      image_conversation_id: attempt.conversation_id,
      attempt_id: attempt.id,
    },
    async () => {
      const operation = observation.start(
        `video.delivery.${job.stage === 'encoding' ? 'encode' : 'upload'}`,
        { provider: 'cloudflare', stage: job.stage }
      );
      let publishing = false;
      try {
        if (job.stage === 'creating')
          throw new VideoStreamError('video_stream_create_unknown', false, true);
        if (Date.now() > Date.parse(job.deadline_at))
          throw new VideoStreamError('video_stream_deadline_exceeded');
        if (job.stage === 'queued' || job.stage === 'uploading') {
          await upload(repository, job, attempt);
          operation.finish({ outcome: 'succeeded', outcome_known: true });
          return;
        }
        const media = await verifyStreamReady(job.stream_uid!);
        if (!media) {
          await repository.release(job);
          operation.finish({ outcome: 'pending', outcome_known: true });
          return;
        }
        const posterPath = `media-plaza-video/attempts/${attempt.id}/poster.jpg`;
        const poster = await streamPoster(job.stream_uid!);
        const dimensions = validatePlazaImage(poster, 'image/jpeg');
        if (!dimensions.width || !dimensions.height)
          throw new VideoStreamError('video_stream_poster_invalid');
        await uploadPlazaVideoAsset({
          path: posterPath,
          bytes: poster,
          contentType: 'image/jpeg',
          upsert: true,
        });
        publishing = true;
        const artifactId = await observation.observe(
          'video.delivery.publish',
          () =>
            repository.publish(job, {
              ...media,
              playbackUrl: stablePlazaPlaybackUrl(job.stream_uid!),
              posterPath,
              posterWidth: dimensions.width,
              posterHeight: dimensions.height,
            }),
          () => ({ provider: 'cloudflare', stage: 'publish' })
        );
        operation.finish({
          outcome: 'succeeded',
          outcome_known: true,
          count: media.renditionCount,
          artifact_id: artifactId,
        });
        if (attempt.provider_request_id)
          await completeVideo(attempt.provider_model_id, attempt.provider_request_id).catch((err) =>
            log.warn({ err, event: 'video_plaza.complete_failed' }, 'Video provider cleanup failed')
          );
      } catch (err) {
        if (publishing) {
          // The next fenced round observes the committed job. Never refund or delete on an unknown RPC response.
          operation.finish({ outcome: 'unknown', outcome_known: false, err });
          log.error(
            { err, event: 'video_plaza.publish_unknown' },
            'Video publish requires reconciliation'
          );
          return;
        }
        const error = err instanceof VideoStreamError ? err : null;
        const transient = !error || error.retryable;
        if (transient && job.retry_count < 10 && Date.now() < Date.parse(job.deadline_at)) {
          await repository.release(job, true, error?.retryAfterMs);
          operation.finish({ outcome: 'degraded', outcome_known: true, err });
          return;
        }
        const unknown = error?.outcomeUnknown ?? true;
        await repository.fail(job, error?.code ?? 'video_stream_delivery_unknown', unknown);
        operation.finish({
          outcome: unknown ? 'unknown' : 'failed',
          outcome_known: !unknown,
          error_code: error?.code,
          err,
        });
      }
    }
  );
}

async function upload(
  repository: VideoDeliveryRepository,
  job: DeliveryJob,
  attempt: Awaited<ReturnType<VideoDeliveryRepository['attempt']>>
) {
  if (!attempt.provider_request_id)
    throw new VideoStreamError('video_stream_source_missing', false, true);
  const result = await retrieveVideo({
    providerModelId: attempt.provider_model_id,
    queueId: attempt.provider_request_id,
  });
  if (result.kind !== 'completed')
    throw new VideoStreamError('video_stream_source_not_ready', true);
  const bytes =
    result.bytes ?? (await downloadVideo(result.downloadUrl ?? attempt.download_url ?? ''));
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
    try {
      session = await createStreamUpload(bytes, attempt.id, attempt.duration_s + 3);
    } catch (err) {
      if (err instanceof VideoStreamError && err.retryable && !err.outcomeUnknown)
        await repository.checkpoint(job, { stage: 'queued' });
      throw err;
    }
    await repository.saveSession(job, session);
  }
  const done = await uploadStreamChunk(session, bytes);
  await repository.checkpoint(job, {
    stage: done ? 'encoding' : 'uploading',
    retry_count: 0,
    ...(done ? { upload_url: null } : {}),
    next_run_at: new Date(Date.now() + (done ? 5000 : 0)).toISOString(),
    lease_token: null,
    lease_expires_at: null,
  });
}
