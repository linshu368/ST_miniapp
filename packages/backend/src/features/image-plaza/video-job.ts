import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../platform/config.js';
import { withBusinessContext } from '../../platform/observability/context.js';
import { finishBackgroundOperation, runObservedJob } from '../../platform/observability/jobs.js';
import { getVideoStreamConfig } from '../../platform/runtime-config.js';
import { startVideoDeliveryJob, stopVideoDeliveryJob } from './video-delivery-job.js';
import { VideoPlazaRepository, type VideoAttemptRow } from './video-repository.js';
import {
  queueVideo,
  recommendedVideoPollDelayMs,
  retrieveVideo,
  VideoPlazaUpstreamError,
} from './video-upstream.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let wakeTick: (() => void) | null = null;

export function wakeVideoPlazaGenerationJob(): void {
  wakeTick?.();
}

export function startVideoPlazaGenerationJob(log: FastifyBaseLogger): void {
  if (!config.imagePlaza.videoWorkerEnabled || !getVideoStreamConfig() || timer) return;
  startVideoDeliveryJob(log);
  const repository = new VideoPlazaRepository();
  const workerId = `video-${process.pid}-${randomUUID()}`;
  let rerunRequested = false;
  const tick = (rerunIfBusy = false): Promise<void> =>
    runObservedJob('video_plaza_generation', async () => {
      if (running) {
        if (rerunIfBusy) rerunRequested = true;
        finishBackgroundOperation('video_plaza_generation', {
          outcome: 'skipped',
          outcome_known: true,
        });
        return;
      }
      running = true;
      try {
        const submitting = await repository.claimSubmitJobs(
          workerId,
          2,
          config.imagePlaza.videoWorkerLeaseSeconds
        );
        await Promise.all(
          submitting.map((attempt) =>
            withBusinessContext(
              {
                business_module: 'image',
                user_id: attempt.user_id,
                image_conversation_id: attempt.conversation_id,
                attempt_id: attempt.id,
              },
              () => submit(repository, attempt, workerId, log)
            )
          )
        );
        const polling = await repository.claimPollJobs(
          workerId,
          2,
          config.imagePlaza.videoWorkerLeaseSeconds
        );
        await Promise.all(
          polling.map((attempt) =>
            withBusinessContext(
              {
                business_module: 'image',
                user_id: attempt.user_id,
                image_conversation_id: attempt.conversation_id,
                attempt_id: attempt.id,
              },
              () => poll(repository, attempt, workerId, log)
            )
          )
        );
        finishBackgroundOperation('video_plaza_generation', {
          outcome: submitting.length + polling.length === 0 ? 'skipped' : 'succeeded',
          outcome_known: true,
        });
      } catch (err) {
        finishBackgroundOperation('video_plaza_generation', {
          outcome: 'failed',
          outcome_known: false,
          err,
        });
        log.error(
          { err, event: 'video_plaza.worker_tick_failed' },
          'Video plaza worker tick failed'
        );
      } finally {
        running = false;
        if (rerunRequested) {
          rerunRequested = false;
          void tick();
        }
      }
    });
  wakeTick = () => void tick(true);
  void tick();
  timer = setInterval(() => void tick(), Math.max(1_000, config.imagePlaza.videoWorkerIntervalMs));
  timer.unref();
}

export function stopVideoPlazaGenerationJob(): void {
  stopVideoDeliveryJob();
  if (timer) clearInterval(timer);
  timer = null;
  wakeTick = null;
  running = false;
}

async function submit(
  repository: VideoPlazaRepository,
  attempt: VideoAttemptRow,
  workerId: string,
  log: FastifyBaseLogger
): Promise<void> {
  const startedAt = Date.now();
  try {
    const referenceUrl = await repository.getReferenceUrl(attempt.reference_artifact_id);
    const queued = await queueVideo({
      providerModelId: attempt.provider_model_id,
      prompt: attempt.prompt,
      duration: attempt.duration_s,
      resolution: attempt.resolution,
      aspectRatio: attempt.aspect_ratio,
      audio: attempt.audio,
      inputMode: attempt.input_mode,
      referenceUrl,
    });
    await repository.markQueued(attempt.id, workerId, queued.queueId, queued.downloadUrl);
    log.info(
      {
        event: 'video_plaza.queued',
        attemptId: attempt.id,
        modelId: attempt.model_id,
        inputMode: attempt.input_mode,
        durationS: attempt.duration_s,
        resolution: attempt.resolution,
        audio: attempt.audio,
        providerLatencyMs: Date.now() - startedAt,
        totalLatencyMs: Math.max(0, Date.now() - Date.parse(attempt.created_at)),
      },
      'Video queued'
    );
  } catch (err) {
    if (err instanceof VideoPlazaUpstreamError && err.disposition === 'retry') {
      await repository.releaseSubmit(attempt.id, workerId, attempt.poll_count + 1);
      log.warn(
        {
          err,
          event: 'video_plaza.submit_retry_scheduled',
          attemptId: attempt.id,
          modelId: attempt.model_id,
          latencyMs: Date.now() - startedAt,
        },
        'Video submit retry scheduled'
      );
      return;
    }
    const unknown = err instanceof VideoPlazaUpstreamError && err.disposition === 'unknown';
    await repository.fail(attempt.id, workerId, {
      status: unknown
        ? 'failed_unknown'
        : err instanceof VideoPlazaUpstreamError && err.code === 'video_moderation_rejected'
          ? 'moderation_rejected'
          : 'failed',
      code: err instanceof VideoPlazaUpstreamError ? err.code : 'video_submit_failed',
      refund: !unknown,
    });
    log.error(
      {
        err,
        event: 'video_plaza.submit_failed',
        attemptId: attempt.id,
        modelId: attempt.model_id,
        inputMode: attempt.input_mode,
        durationS: attempt.duration_s,
        resolution: attempt.resolution,
        audio: attempt.audio,
        latencyMs: Date.now() - startedAt,
        totalLatencyMs: Math.max(0, Date.now() - Date.parse(attempt.created_at)),
      },
      'Video submit failed'
    );
  }
}

async function poll(
  repository: VideoPlazaRepository,
  attempt: VideoAttemptRow,
  workerId: string,
  log: FastifyBaseLogger
): Promise<void> {
  const startedAt = Date.now();
  if (!attempt.provider_request_id) {
    await repository.fail(attempt.id, workerId, {
      status: 'failed_unknown',
      code: 'video_provider_request_missing',
      refund: false,
    });
    return;
  }
  let handingOff = false;
  try {
    const result = await retrieveVideo({
      providerModelId: attempt.provider_model_id,
      queueId: attempt.provider_request_id,
    });
    if (result.kind === 'processing') {
      const nextPollDelayMs = recommendedVideoPollDelayMs({
        pollCount: attempt.poll_count,
        averageExecutionTimeMs: result.averageExecutionTimeMs,
        executionDurationMs: result.executionDurationMs,
      });
      await repository.schedulePoll(
        attempt.id,
        workerId,
        'processing',
        attempt.poll_count + 1,
        nextPollDelayMs
      );
      return;
    }
    handingOff = true;
    await repository.markStoring(attempt.id, workerId, result.downloadUrl ?? attempt.download_url);
    log.info(
      { event: 'video_plaza.delivery_enqueued', stage: 'storing', provider: 'cloudflare' },
      'Video delivery enqueued'
    );
  } catch (err) {
    if (handingOff) {
      log.error(
        { err, event: 'video_plaza.delivery_handoff_unknown' },
        'Video delivery handoff requires reconciliation'
      );
      return;
    }
    if (err instanceof VideoPlazaUpstreamError && err.disposition === 'retry') {
      if (Date.now() - Date.parse(attempt.created_at) < config.imagePlaza.videoPollDeadlineMs) {
        await repository.schedulePoll(attempt.id, workerId, 'processing', attempt.poll_count + 1);
        return;
      }
      await repository.fail(attempt.id, workerId, {
        status: 'failed_unknown',
        code: 'video_poll_deadline_exceeded',
        refund: false,
      });
      return;
    }
    const moderation =
      err instanceof VideoPlazaUpstreamError && err.code === 'video_moderation_rejected';
    const expired =
      err instanceof VideoPlazaUpstreamError && err.code === 'video_provider_media_expired';
    await repository.fail(attempt.id, workerId, {
      status: moderation ? 'moderation_rejected' : expired ? 'expired' : 'failed',
      code: err instanceof VideoPlazaUpstreamError ? err.code : 'video_processing_failed',
      refund: true,
    });
    log.error(
      {
        err,
        event: 'video_plaza.poll_failed',
        attemptId: attempt.id,
        modelId: attempt.model_id,
        pollCount: attempt.poll_count,
        latencyMs: Date.now() - startedAt,
        totalLatencyMs: Math.max(0, Date.now() - Date.parse(attempt.created_at)),
      },
      'Video processing failed'
    );
  }
}
