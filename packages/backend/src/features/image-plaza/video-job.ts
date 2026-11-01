import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../platform/config.js';
import { deletePlazaVideoAssets, uploadPlazaVideoAsset } from './storage.js';
import { VideoPlazaRepository, type VideoAttemptRow } from './video-repository.js';
import {
  completeVideo,
  downloadVideo,
  queueVideo,
  recommendedVideoPollDelayMs,
  retrieveVideo,
  VideoPlazaUpstreamError,
} from './video-upstream.js';
import { isVideoMediaAvailable, prepareVideo } from './video-media.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let wakeTick: (() => void) | null = null;

export function wakeVideoPlazaGenerationJob(): void {
  wakeTick?.();
}

export function startVideoPlazaGenerationJob(log: FastifyBaseLogger): void {
  if (!config.imagePlaza.videoWorkerEnabled || !isVideoMediaAvailable() || timer) return;
  const repository = new VideoPlazaRepository();
  const workerId = `video-${process.pid}-${randomUUID()}`;
  let rerunRequested = false;
  const tick = async (rerunIfBusy = false): Promise<void> => {
    if (running) {
      if (rerunIfBusy) rerunRequested = true;
      return;
    }
    running = true;
    try {
      const submitting = await repository.claimSubmitJobs(
        workerId,
        2,
        config.imagePlaza.videoWorkerLeaseSeconds
      );
      await Promise.all(submitting.map((attempt) => submit(repository, attempt, workerId, log)));
      const polling = await repository.claimPollJobs(
        workerId,
        2,
        config.imagePlaza.videoWorkerLeaseSeconds
      );
      await Promise.all(polling.map((attempt) => poll(repository, attempt, workerId, log)));
    } catch (err) {
      log.error({ err, event: 'video_plaza.worker_tick_failed' }, 'Video plaza worker tick failed');
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        void tick();
      }
    }
  };
  wakeTick = () => void tick(true);
  void tick();
  timer = setInterval(() => void tick(), Math.max(1_000, config.imagePlaza.videoWorkerIntervalMs));
  timer.unref();
}

export function stopVideoPlazaGenerationJob(): void {
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
  const storagePath = `media-plaza-video/attempts/${attempt.id}/video.mp4`;
  const posterPath = `media-plaza-video/attempts/${attempt.id}/poster.jpg`;
  let publishing = false;
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
    await repository.markStoring(attempt.id, workerId, result.downloadUrl ?? attempt.download_url);
    const bytes =
      result.bytes ?? (await downloadVideo(result.downloadUrl ?? attempt.download_url ?? ''));
    const media = await prepareVideo(bytes);
    const uploadResults = await Promise.allSettled([
      uploadPlazaVideoAsset({
        path: storagePath,
        bytes: media.video,
        contentType: 'video/mp4',
      }),
      uploadPlazaVideoAsset({
        path: posterPath,
        bytes: media.poster,
        contentType: 'image/jpeg',
      }),
    ]);
    const failedUpload = uploadResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failedUpload) throw failedUpload.reason;
    // RPC 提交结果一旦可能未知，就保留对象交给对账流程，避免删除其实已发布的资源。
    publishing = true;
    await repository.publish({
      attemptId: attempt.id,
      workerId,
      storagePath,
      byteSize: media.video.byteLength,
      width: media.width,
      height: media.height,
      durationMs: media.durationMs,
      posterPath,
      posterWidth: media.width,
      posterHeight: media.height,
    });
    void completeVideo(attempt.provider_model_id, attempt.provider_request_id).catch((err) =>
      log.warn(
        { err, event: 'video_plaza.complete_failed', attemptId: attempt.id },
        'Video provider cleanup failed'
      )
    );
    log.info(
      {
        event: 'video_plaza.ready',
        attemptId: attempt.id,
        modelId: attempt.model_id,
        pollCount: attempt.poll_count,
        finalizationLatencyMs: Date.now() - startedAt,
        totalLatencyMs: Math.max(0, Date.now() - Date.parse(attempt.created_at)),
      },
      'Video ready'
    );
  } catch (err) {
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
    if (!publishing) {
      await deletePlazaVideoAssets([storagePath, posterPath]).catch((cleanupErr) =>
        log.warn(
          { err: cleanupErr, event: 'video_plaza.storage_cleanup_failed', attemptId: attempt.id },
          'Video storage cleanup failed'
        )
      );
    }
    const moderation =
      err instanceof VideoPlazaUpstreamError && err.code === 'video_moderation_rejected';
    const expired =
      err instanceof VideoPlazaUpstreamError && err.code === 'video_provider_media_expired';
    await repository.fail(attempt.id, workerId, {
      status: moderation ? 'moderation_rejected' : expired ? 'expired' : 'failed',
      code: err instanceof Error ? err.message.slice(0, 120) : 'video_processing_failed',
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
