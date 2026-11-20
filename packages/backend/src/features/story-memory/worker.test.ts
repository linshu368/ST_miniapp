import pino from 'pino';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STORY_MEMORY_CONFIG } from '@miniapp/shared';
import type {
  StoryMemoryRepository,
  ClaimedStoryMemoryJob,
} from '../../infrastructure/repositories/StoryMemoryRepository.js';
import type { StoryMemoryJobContext } from './compress-job.js';
import { fastifyLoggerOptions } from '../../platform/observability/logger.js';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  config: vi.fn(),
  prompt: vi.fn(),
  alert: vi.fn(),
}));
vi.mock('./compress-job.js', () => ({
  runStoryMemoryJob: mocks.run,
  storyMemoryErrorCode: () => 'too_long',
}));
vi.mock('./config.js', () => ({
  fetchStoryMemoryConfig: mocks.config,
  fetchStoryMemoryPrompt: mocks.prompt,
}));
vi.mock('../../lib/sentry.js', () => ({ sendBackendSentryLog: mocks.alert }));
vi.mock('../../platform/config.js', () => ({ config: { storyMemory: { workerEnabled: false } } }));
vi.mock('../../infrastructure/repositories/StoryMemoryRepository.js', () => ({
  StoryMemoryRepository: class {},
}));
import { processClaimedJobs } from './worker.js';

function job(suffix = '1'): ClaimedStoryMemoryJob {
  return {
    sessionId: `session-${suffix}`,
    userId: 'user',
    characterId: 'character',
    windowStart: 1,
    targetEnd: 10,
    coveredEndTurn: 0,
    attempts: 0,
    memoryContent: null,
  };
}
const progress = { rangeStart: 1, rangeEnd: 5, chunks: 1, inputChars: 900, outputChars: 100 };
function fixture() {
  const rows: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      rows.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      done();
    },
  });
  const log = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, stream);
  const repository = {
    claimJobs: vi.fn().mockResolvedValue([]),
    finishJob: vi.fn().mockResolvedValue({ status: 'idle', attempts: 0 }),
  };
  return {
    rows,
    repository,
    run: () => processClaimedJobs(log, repository as unknown as StoryMemoryRepository, 'worker'),
    summaries: () => rows.filter((row) => row.event === 'story_memory.job.finished'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue(DEFAULT_STORY_MEMORY_CONFIG);
  mocks.prompt.mockResolvedValue({ template: 'private-prompt', version: 'v1' });
  mocks.run.mockReset().mockResolvedValue({ ...progress, rangeEnd: 10 });
});

describe('story-memory worker claims and terminal outcomes', () => {
  it('claims each job only after the previous one finished, with at most three per pass', async () => {
    const f = fixture();
    const order: string[] = [];
    f.repository.claimJobs.mockImplementation(async () => {
      order.push('claim');
      return [job(String(f.repository.claimJobs.mock.calls.length))];
    });
    mocks.run.mockImplementation(async () => {
      order.push('run');
      return progress;
    });
    f.repository.finishJob.mockImplementation(async () => {
      order.push('finish');
      return { status: 'idle', attempts: 0 };
    });
    await expect(f.run()).resolves.toBe('success');
    expect(order).toEqual([
      'claim',
      'run',
      'finish',
      'claim',
      'run',
      'finish',
      'claim',
      'run',
      'finish',
    ]);
    expect(f.repository.claimJobs.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ['worker', 1, 900])
    );
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty claim and skips disabled config without claiming', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe('skipped');
    expect(f.repository.claimJobs).toHaveBeenCalledOnce();
    expect(mocks.prompt).not.toHaveBeenCalled();
    mocks.config.mockResolvedValue({ ...DEFAULT_STORY_MEMORY_CONFIG, enabled: false });
    f.repository.claimJobs.mockClear();
    await expect(f.run()).resolves.toBe('skipped');
    expect(f.repository.claimJobs).not.toHaveBeenCalled();
  });

  it('preserves committed progress in failure summary and finish range', async () => {
    const f = fixture();
    f.repository.claimJobs.mockResolvedValueOnce([job()]);
    f.repository.finishJob.mockResolvedValue({ status: 'pending', attempts: 2 });
    mocks.run.mockImplementation(
      async (_job: ClaimedStoryMemoryJob, ctx: StoryMemoryJobContext) => {
        ctx.onProgress?.(progress);
        throw new Error('private-failed-second-chunk');
      }
    );
    await expect(f.run()).resolves.toBe('partial');
    expect(f.summaries()[0]).toMatchObject({
      outcome: 'failed',
      range_start: 1,
      range_end: 5,
      target_end: 10,
      chunk_count: 1,
      input_chars: 900,
      output_chars: 100,
      prompt_version: 'v1',
      failure_count: 2,
    });
    expect(f.repository.finishJob).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeStart: 1,
        rangeEnd: 5,
        errorCode: 'too_long',
      })
    );
    expect(JSON.stringify(f.rows)).not.toContain('private');
  });

  it.each(['lease_lost', 'thrown', 'unexpected'])(
    'does not report success when finish is %s',
    async (status) => {
      const f = fixture();
      f.repository.claimJobs.mockResolvedValueOnce([job()]);
      if (status === 'thrown')
        f.repository.finishJob.mockRejectedValue(new Error('private-finish-error'));
      else f.repository.finishJob.mockResolvedValue({ status, attempts: 3 });
      await expect(f.run()).resolves.toBe('partial');
      expect(f.summaries()[0]).toMatchObject({ outcome: 'unknown' });
      expect(mocks.alert).not.toHaveBeenCalled();
      expect(f.repository.finishJob).toHaveBeenCalledOnce();
    }
  );

  it.each([3, 4])(
    'alerts only on the third consecutive committed failure (attempt %s)',
    async (attempts) => {
      const f = fixture();
      f.repository.claimJobs.mockResolvedValueOnce([job()]);
      f.repository.finishJob.mockResolvedValue({ status: 'pending', attempts });
      mocks.run.mockRejectedValue(new Error('compression failed'));
      await expect(f.run()).resolves.toBe('partial');
      expect(mocks.alert).toHaveBeenCalledTimes(attempts === 3 ? 1 : 0);
      expect(f.summaries()[0]).not.toHaveProperty('output_chars');
    }
  );

  it('finishes already claimed jobs when the shared prompt cannot be loaded', async () => {
    const f = fixture();
    f.repository.claimJobs.mockResolvedValueOnce([job()]);
    mocks.prompt.mockRejectedValue(new Error('config unavailable'));
    await expect(f.run()).resolves.toBe('partial');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(f.repository.finishJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'config_unavailable' })
    );
  });
});
