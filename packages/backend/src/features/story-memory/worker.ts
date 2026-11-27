import { runObservedJob } from '../../platform/observability/jobs.js';
import { withBusinessContext } from '../../platform/observability/context.js';
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
import type { StoryMemoryAttemptDetail } from './compression-attempt.js';

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

function logAttempt(log: FastifyBaseLogger, detail: StoryMemoryAttemptDetail): void {
  const failed = detail.outcome !== 'succeeded' && detail.outcome !== 'rejected';
  const fields = {
    event: failed ? 'story_memory.compression.failed' : 'story_memory.compression.completed',
    // 删条目是程序做的，不是上游调用
    provider: detail.stage === 'trim' ? 'local' : 'surplus',
    ...detail,
  };
  if (failed || detail.outcome === 'rejected') log.warn(fields, '记忆压缩尝试结束');
  else log.info(fields, '记忆压缩尝试完成');
}

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
    rangeEnd: job.coveredEndTurn,
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
        onAttempt: (detail) => logAttempt(log, { ...detail, job_attempt: job.attempts + 1 }),
        onProgress: (progress) => {
          detail = progress;
        },
        onRejected: (reason, detail) =>
          log.warn(
            {
              event: 'story_memory.validation.rejected',
              sessionId: job.sessionId,
              reason,
              job_attempt: job.attempts + 1,
              ...detail,
            },
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
  const finishKnown = finished !== null && ['idle', 'pending', 'failed'].includes(finished.status);
  const succeeded = errorCode === null && finishKnown && finished.status !== 'failed';
  const outcome = !finishKnown ? 'unknown' : succeeded ? 'succeeded' : 'failed';
  const summaryCode =
    errorCode ?? (!finishKnown ? (finished?.status ?? 'finish_failed') : undefined);
  log[succeeded ? 'info' : 'error'](
    {
      event: 'story_memory.job.finished',
      sessionId: job.sessionId,
      outcome,
      error_code: summaryCode,
      durationMs: Math.round(performance.now() - startedAt),
      model: inputs?.model ?? null,
      prompt_version: inputs?.prompt.version ?? null,
      status: finished?.status ?? null,
      job_attempt: job.attempts + 1,
      failure_count: finished?.attempts,
      range_start: detail.rangeStart,
      range_end: detail.rangeEnd,
      target_end: job.targetEnd,
      chunk_count: detail.chunks,
      input_chars: detail.inputChars,
      ...(detail.chunks > 0 ? { output_chars: detail.outputChars } : {}),
    },
    succeeded ? '记忆任务完成' : '记忆任务未成功收尾'
  );
  // Without an alert, a session whose memory keeps failing silently stops updating.
  // Alert once per failure streak (the third consecutive failure): attempts only reset on
  // success, so `>=` would send one Sentry log for every later retry of the same stuck session.
  if (errorCode && finishKnown && finished.attempts === ALERT_AFTER_ATTEMPTS) {
    sendBackendSentryLog('error', 'story_memory.job.repeated_failure', {
      sessionId: job.sessionId,
      attempts: finished.attempts,
      errorCode,
    });
  }
  return succeeded;
}

function isClaimTimeout(err: unknown): boolean {
  return err instanceof Error && /abort|timed? ?out|timeout/i.test(err.message);
}

export async function processClaimedJobs(
  log: FastifyBaseLogger,
  repository: StoryMemoryRepository,
  workerId: string
): Promise<'success' | 'partial' | 'skipped'> {
  const config = await fetchStoryMemoryConfig();
  if (!config.enabled) return 'skipped';
  let inputs: Awaited<ReturnType<typeof loadJobInputs>> | null | undefined;
  let outcome: 'success' | 'partial' | 'skipped' = 'skipped';
  for (let index = 0; index < CLAIM_LIMIT; index += 1) {
    // A queued claim already spends its lease while preceding multi-chunk jobs run.
    const jobs = await repository.claimJobs(workerId, 1, LEASE_SECONDS).catch((err: unknown) => {
      // 领取只是定时轮询，超时下一个周期自然重试，不算错误；其他失败照常上报。
      if (!isClaimTimeout(err)) throw err;
      log.warn({ event: 'story_memory.claim.timeout' }, '领取记忆任务超时，下个周期重试');
      return null;
    });
    if (!jobs || jobs.length === 0) break;
    // Claimed jobs must always be finished, even when shared inputs cannot be loaded.
    if (inputs === undefined)
      inputs = await loadJobInputs(config).catch((err: unknown) => {
        log.error({ err, event: 'story_memory.inputs.failed' }, '记忆任务的 prompt 或模型读取失败');
        return null;
      });

    const job = jobs[0]!;
    const jobInputs = inputs ?? null;
    const ok = await withBusinessContext(
      {
        business_module: 'chat',
        user_id: job.userId,
        session_id: job.sessionId,
        character_id: job.characterId,
      },
      () => processJob({ log, repository, workerId, config, job, inputs: jobInputs })
    );
    if (!ok) outcome = 'partial';
    else if (outcome === 'skipped') outcome = 'success';
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
  timer = setInterval(() => void runObservedJob('story_memory', tick), TICK_INTERVAL_MS);
  timer.unref();
}

export function stopStoryMemoryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
