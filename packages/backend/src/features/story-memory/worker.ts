/**
 * 会话长期记忆的后台 worker。进程内定时领取，多副本靠 SKIP LOCKED 与租约互斥。
 * 任何失败只影响记忆本身：旧版本保留，任务按退避重试。
 */
import { randomUUID } from 'node:crypto';
import type { StoryMemoryConfig } from '@miniapp/shared';
import type { FastifyBaseLogger } from 'fastify';
import {
  StoryMemoryRepository,
  type ClaimedStoryMemoryJob,
} from '../../infrastructure/repositories/StoryMemoryRepository.js';
import { observeBackgroundRun } from '../../lib/background-observability.js';
import { sendBackendSentryLog } from '../../lib/sentry.js';
import { config as appConfig } from '../../platform/config.js';
import { runStoryMemoryJob, storyMemoryErrorCode } from './compress-job.js';
import { fetchStoryMemoryConfig, fetchStoryMemoryPrompt } from './config.js';

const TICK_INTERVAL_MS = 10_000;
const CLAIM_LIMIT = 3;
/** running 超过它视为失败，可被重新领取；每提交一块会续租 */
const LEASE_SECONDS = 15 * 60;
const ALERT_AFTER_ATTEMPTS = 3;

let timer: NodeJS.Timeout | null = null;
let running = false;

type JobDetail = {
  rangeStart: number;
  rangeEnd: number;
  chunks: number;
  inputChars: number;
  outputChars: number;
};

async function loadJobInputs(config: StoryMemoryConfig) {
  const prompt = await fetchStoryMemoryPrompt(AbortSignal.timeout(5_000));
  return { prompt, model: config.model_id };
}

async function processJob(input: {
  log: FastifyBaseLogger;
  repository: StoryMemoryRepository;
  workerId: string;
  config: StoryMemoryConfig;
  job: ClaimedStoryMemoryJob;
  inputs: Awaited<ReturnType<typeof loadJobInputs>> | null;
}): Promise<boolean> {
  const { log, repository, workerId, job, inputs } = input;
  const startedAt = performance.now();
  let errorCode: string | null = inputs ? null : 'config_unavailable';
  let detail: JobDetail = {
    rangeStart: job.coveredEndTurn + 1,
    rangeEnd: job.targetEnd,
    chunks: 0,
    inputChars: 0,
    outputChars: 0,
  };
  if (inputs) {
    try {
      detail = await runStoryMemoryJob(job, {
        repository,
        workerId,
        leaseSeconds: LEASE_SECONDS,
        config: input.config,
        prompt: inputs.prompt,
        model: inputs.model,
        onRejected: (reason) =>
          log.warn(
            { event: 'story_memory.validation.rejected', sessionId: job.sessionId, reason },
            '压缩结果未通过校验'
          ),
      });
    } catch (err) {
      errorCode = storyMemoryErrorCode(err);
      log.error(
        { err, event: 'story_memory.job.error', sessionId: job.sessionId, errorCode },
        '记忆任务失败，保留旧版本'
      );
    }
  }

  // A failed finish leaves the lease to expire; the job is reclaimed later.
  const finished = await repository
    .finishJob({
      sessionId: job.sessionId,
      workerId,
      errorCode,
      rangeStart: detail.rangeStart,
      rangeEnd: detail.rangeEnd,
    })
    .catch((err: unknown) => {
      log.error(
        { err, event: 'story_memory.job.finish_failed', sessionId: job.sessionId },
        '记忆任务收尾失败'
      );
      return null;
    });
  log.info(
    {
      event: 'story_memory.job.finished',
      sessionId: job.sessionId,
      outcome: errorCode ? 'failed' : 'succeeded',
      errorCode,
      durationMs: Math.round(performance.now() - startedAt),
      model: inputs?.model ?? null,
      promptVersion: inputs?.prompt.version ?? null,
      status: finished?.status ?? null,
      attempts: finished?.attempts ?? null,
      ...detail,
    },
    errorCode ? '记忆任务失败' : '记忆任务完成'
  );
  // Without an alert, a session whose memory keeps failing silently stops updating.
  if (errorCode && finished && finished.attempts >= ALERT_AFTER_ATTEMPTS) {
    sendBackendSentryLog('error', 'story_memory.job.repeated_failure', {
      sessionId: job.sessionId,
      attempts: finished.attempts,
      errorCode,
    });
  }
  return errorCode === null;
}

function isClaimTimeout(err: unknown): boolean {
  return err instanceof Error && /abort|timed? ?out|timeout/i.test(err.message);
}

async function processClaimedJobs(
  log: FastifyBaseLogger,
  repository: StoryMemoryRepository,
  workerId: string
): Promise<'success' | 'partial' | 'skipped'> {
  const config = await fetchStoryMemoryConfig();
  if (!config.enabled) return 'skipped';
  const jobs = await repository
    .claimJobs(workerId, CLAIM_LIMIT, LEASE_SECONDS)
    .catch((err: unknown) => {
      // 领取只是定时轮询，超时下一个周期自然重试，不算错误；其他失败照常上报。
      if (!isClaimTimeout(err)) throw err;
      log.warn({ event: 'story_memory.claim.timeout' }, '领取记忆任务超时，下个周期重试');
      return null;
    });
  if (!jobs || jobs.length === 0) return 'skipped';
  // Claimed jobs must always be finished, even when shared inputs cannot be loaded.
  const inputs = await loadJobInputs(config).catch((err: unknown) => {
    log.error({ err, event: 'story_memory.inputs.failed' }, '记忆任务的 prompt 或模型读取失败');
    return null;
  });

  let outcome: 'success' | 'partial' = 'success';
  for (const job of jobs) {
    const ok = await processJob({ log, repository, workerId, config, job, inputs });
    if (!ok) outcome = 'partial';
  }
  return outcome;
}

export function startStoryMemoryJob(log: FastifyBaseLogger): void {
  if (!appConfig.storyMemory.workerEnabled || timer) return;
  const workerId = `story-memory-${randomUUID()}`;
  const repository = new StoryMemoryRepository();
  const tick = async () => {
    const startedAt = performance.now();
    if (running) {
      observeBackgroundRun({ job: 'story_memory', outcome: 'skipped', startedAt });
      return;
    }
    running = true;
    try {
      const outcome = await processClaimedJobs(log, repository, workerId);
      observeBackgroundRun({ job: 'story_memory', outcome, startedAt });
    } catch (err) {
      log.error({ err, event: 'story_memory.worker.failed' }, '记忆 worker 本轮失败');
      observeBackgroundRun({ job: 'story_memory', outcome: 'error', startedAt, error: err });
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  timer.unref();
}

export function stopStoryMemoryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
