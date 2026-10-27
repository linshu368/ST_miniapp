import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../platform/config.js';
import { deletePlazaVideoAssets, uploadPlazaVideoAsset } from './storage.js';
import { VideoPlazaRepository, type VideoAttemptRow } from './video-repository.js';
import {
  completeVideo,
  downloadVideo,
  queueVideo,
  retrieveVideo,
  VideoPlazaUpstreamError,
} from './video-upstream.js';
import { isVideoMediaAvailable, prepareVideo } from './video-media.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startVideoPlazaGenerationJob(log: FastifyBaseLogger): void {
  if (!config.imagePlaza.videoWorkerEnabled || !isVideoMediaAvailable() || timer) return;
  const repository = new VideoPlazaRepository();
  const workerId = `video-${process.pid}-${randomUUID()}`;
  const tick = async () => {
    if (running) return;
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
    }
  };
  void tick();
  timer = setInterval(() => void tick(), Math.max(1_000, config.imagePlaza.videoWorkerIntervalMs));
  timer.unref();
}

export function stopVideoPlazaGenerationJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

async function submit(
  repository: VideoPlazaRepository,
  attempt: VideoAttemptRow,
  workerId: string,
  log: FastifyBaseLogger
): Promise<void> {
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
    log.info({ event: 'video_plaza.queued', attemptId: attempt.id }, 'Video queued');
  } catch (err) {
    if (err instanceof VideoPlazaUpstreamError && err.disposition === 'retry') {
      await repository.releaseSubmit(attempt.id, workerId, attempt.poll_count + 1);
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
      { err, event: 'video_plaza.submit_failed', attemptId: attempt.id },
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
      await repository.schedulePoll(attempt.id, workerId, 'processing', attempt.poll_count + 1);
      return;
    }
    await repository.markStoring(attempt.id, workerId, result.downloadUrl ?? attempt.download_url);
    const bytes =
      result.bytes ?? (await downloadVideo(result.downloadUrl ?? attempt.download_url ?? ''));
    const media = await prepareVideo(bytes);
    await uploadPlazaVideoAsset({
      path: storagePath,
      bytes: media.video,
      contentType: 'video/mp4',
    });
    await uploadPlazaVideoAsset({
      path: posterPath,
      bytes: media.poster,
      contentType: 'image/jpeg',
    });
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
    log.info({ event: 'video_plaza.ready', attemptId: attempt.id }, 'Video ready');
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
      { err, event: 'video_plaza.poll_failed', attemptId: attempt.id },
      'Video processing failed'
    );
  }
}
