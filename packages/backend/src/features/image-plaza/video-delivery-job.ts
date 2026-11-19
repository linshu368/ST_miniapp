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
import { uploadVideoDelivery } from './video-delivery-upload.js';
import {
  stablePlazaPlaybackUrl,
  streamPoster,
  verifyStreamReady,
} from './video-stream-playback.js';
import { completeVideo } from './video-upstream.js';
import { validatePlazaImage, uploadPlazaVideoAsset } from './storage.js';

let timer: NodeJS.Timeout | undefined;
let running = false;
let stopping = false;
let activeRound: Promise<void> | undefined;
let shutdown = new AbortController();
let workerLog: FastifyBaseLogger | undefined;

export function startVideoDeliveryJob(log: FastifyBaseLogger) {
  if (timer || running || !config.imagePlaza.videoWorkerEnabled) return;
  stopping = false;
  shutdown = new AbortController();
  workerLog = log;
  const repository = new VideoDeliveryRepository();
  const tick = () =>
    runObservedJob('video_plaza_delivery', async () => {
      if (running || stopping) {
        finishBackgroundOperation('video_plaza_delivery', {
          outcome: 'skipped',
          outcome_known: true,
        });
        return;
      }
      running = true;
      const round = runDeliveryRound(repository, log).finally(() => {
        running = false;
        if (activeRound === round) activeRound = undefined;
      });
      activeRound = round;
      await round;
    });
  timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
}

export async function stopVideoDeliveryJob(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  shutdown.abort(new DOMException('video_delivery_shutdown', 'AbortError'));
  let deadline: NodeJS.Timeout | undefined;
  const drained = await Promise.race([
    (activeRound ?? Promise.resolve()).then(() => true),
    new Promise<boolean>((resolve) => {
      deadline = setTimeout(() => resolve(false), 30_000);
    }),
  ]);
  if (deadline) clearTimeout(deadline);
  workerLog?.info(
    {
      event: 'video_plaza.delivery_stopped',
      outcome: drained ? 'succeeded' : 'unknown',
      stage: drained ? 'drained' : 'lease_protected',
    },
    'Video delivery stopped'
  );
}

async function deliver(
  repository: VideoDeliveryRepository,
  job: DeliveryJob,
  log: FastifyBaseLogger
) {
  const attempt = await repository.attempt(job.attempt_id);
  // Creation keeps its original timeout: a short remaining upload budget must
  // not manufacture an ambiguous non-idempotent POST. Known TUS bursts yield
  // between chunks; read-only encoding checks can use a hard round deadline.
  const signal =
    job.stage === 'encoding'
      ? AbortSignal.any([shutdown.signal, AbortSignal.timeout(20_000)])
      : shutdown.signal;
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
          await uploadVideoDelivery(repository, job, attempt, signal);
          operation.finish({ outcome: 'succeeded', outcome_known: true });
          return;
        }
        const media = await verifyStreamReady(job.stream_uid!, signal);
        if (!media) {
          await repository.release(job);
          operation.finish({ outcome: 'pending', outcome_known: true });
          return;
        }
        signal.throwIfAborted();
        const posterPath = `media-plaza-video/attempts/${attempt.id}/poster.jpg`;
        const poster = await streamPoster(job.stream_uid!, signal);
        const dimensions = validatePlazaImage(poster, 'image/jpeg');
        if (!dimensions.width || !dimensions.height)
          throw new VideoStreamError('video_stream_poster_invalid');
        await uploadPlazaVideoAsset({
          path: posterPath,
          bytes: poster,
          contentType: 'image/jpeg',
          upsert: true,
        });
        signal.throwIfAborted();
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
        if (roundWasCancelled(err, signal, job.stage)) {
          // The awaited network operation has settled. A known TUS session can
          // resume via HEAD; uncertain creation keeps its original protection.
          const uncertain = job.stage === 'creating';
          if (!uncertain) await repository.release(job);
          operation.finish({
            outcome: uncertain ? 'unknown' : 'interrupted',
            outcome_known: !uncertain,
            stage: uncertain ? 'creating' : 'round_budget',
            err,
          });
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

function roundWasCancelled(
  error: unknown,
  signal: AbortSignal,
  stage: DeliveryJob['stage']
): boolean {
  if (!signal.aborted) return false;
  if (
    stage === 'creating' &&
    error instanceof VideoStreamError &&
    error.code === 'video_stream_create_unknown'
  )
    return true;
  // Preserve independent provider errors (including Retry-After) racing a stop.
  // Transport wrappers may retain the exact caller reason through their cause.
  let cause = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (cause === signal.reason) return true;
    if (!(cause instanceof Error)) return false;
    cause = cause.cause;
  }
  return false;
}

async function runDeliveryRound(repository: VideoDeliveryRepository, log: FastifyBaseLogger) {
  try {
    requireVideoStreamConfig();

    const jobs = await repository.claim();
    await Promise.all(
      jobs.map((job) =>
        withBusinessContext({ business_module: 'image', attempt_id: job.attempt_id }, async () => {
          try {
            if (stopping) {
              if (job.stage !== 'creating') await repository.release(job);
            } else await deliver(repository, job, log);
          } catch (err) {
            log.error(
              { err, event: 'video_plaza.delivery_round_unknown' },
              'Video delivery round requires reconciliation'
            );
          }
        })
      )
    );
    if (stopping) return;
    for (const asset of await repository.failedAssets()) {
      if (stopping) return;
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
  }
}
