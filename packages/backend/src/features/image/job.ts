import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '../../lib/logger.js';
import { config } from '../../platform/config.js';
import { ChatMessageImageRepository } from '../../infrastructure/repositories/ChatMessageImageRepository.js';
import { getImageRuntimeConfig } from './config.js';
import { runImageGeneration } from './generate.js';
import { observeBackgroundRun } from '../../lib/background-observability.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
const workerId = `image-${process.pid}-${randomUUID().slice(0, 8)}`;

export function startChatImageGenerationJob(appLog?: FastifyBaseLogger): void {
  if (timer || !config.image.workerEnabled) return;
  const log = createLogger('image');
  appLog?.info('[image-job] Chat image generation job enabled');
  timer = setInterval(() => {
    void tick(log);
  }, config.image.workerIntervalMs);
  timer.unref();
  void tick(log);
}

export function stopChatImageGenerationJob(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(log: Logger): Promise<void> {
  const startedAt = performance.now();
  if (running) {
    observeBackgroundRun({ job: 'chat_image_generation', outcome: 'skipped', startedAt });
    return;
  }
  running = true;
  let outcome: 'success' | 'skipped' | 'error' = 'success';
  let terminalError: unknown;
  try {
    const imageConfig = await getImageRuntimeConfig();
    const repo = new ChatMessageImageRepository();
    const jobs = await repo.claim(3, workerId, config.image.workerLeaseSeconds);
    if (jobs.length === 0) {
      outcome = 'skipped';
      return;
    }
    await Promise.all(jobs.map((attempt) => runImageGeneration({ attempt, imageConfig, log })));
  } catch (error) {
    outcome = 'error';
    terminalError = error;
    log.sys.error({ event: 'image.job.tick_failed', err: error }, '图片生成任务轮询失败');
  } finally {
    observeBackgroundRun({
      job: 'chat_image_generation',
      outcome,
      startedAt,
      error: terminalError,
    });
    running = false;
  }
}
