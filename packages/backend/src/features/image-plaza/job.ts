import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../platform/config.js';
import { ImagePlazaRepository } from './repository.js';
import { generateImagePlazaImage, ImagePlazaUpstreamError } from './upstream.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startImagePlazaGenerationJob(log: FastifyBaseLogger): void {
  if (!config.imagePlaza.workerEnabled || timer) return;
  const workerId = `image-plaza-${randomUUID()}`;
  const repository = new ImagePlazaRepository();
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await repository.markStaleDispatchedUnknown(new Date().toISOString());
      const jobs = await repository.claimJobs(workerId, 2, config.imagePlaza.workerLeaseSeconds);
      for (const attempt of jobs) {
        try {
          const reference = attempt.referenceArtifactId
            ? await repository.loadReference(attempt.referenceArtifactId, attempt.userId)
            : undefined;
          await repository.markGenerating(attempt.id);
          const generated = await generateImagePlazaImage({
            providerModelId: attempt.providerModelId,
            prompt: attempt.prompt,
            aspectRatio: attempt.aspectRatio,
            resolution: attempt.resolution,
            mode: attempt.mode,
            ...(reference ? { reference } : {}),
          });
          await repository.settleGeneratedImage({
            attempt,
            bytes: generated.bytes,
            mimeType: generated.mimeType,
          });
          log.info(
            { event: 'image_plaza.generation.ready', attemptId: attempt.id },
            'Image plaza generation completed'
          );
        } catch (err) {
          const upstream = err instanceof ImagePlazaUpstreamError ? err : null;
          await repository
            .markFailed(
              attempt.id,
              upstream?.code ?? 'image_plaza_generation_failed',
              upstream?.outcomeUnknown ?? false
            )
            .catch((markErr) =>
              log.error(
                { err: markErr, attemptId: attempt.id },
                'Image plaza failure marking failed'
              )
            );
          log.error(
            { err, event: 'image_plaza.generation.failed', attemptId: attempt.id },
            'Image plaza generation failed'
          );
        }
      }
    } catch (err) {
      log.error({ err, event: 'image_plaza.worker.failed' }, 'Image plaza worker tick failed');
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), Math.max(1000, config.imagePlaza.workerIntervalMs));
  timer.unref();
  void tick();
}

export function stopImagePlazaGenerationJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
