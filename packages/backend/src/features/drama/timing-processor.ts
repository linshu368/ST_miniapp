import type { DramaTimingReport } from '@miniapp/shared';
import type { RequestLogger } from '../../lib/logger.js';
import { DramaTimingRepository } from './timing-repository.js';

interface TimingJob {
  report: DramaTimingReport;
  log: RequestLogger;
  enqueuedAt: number;
}

const MAX_CONCURRENCY = 2;
const MAX_QUEUED = 32;

/** Process-local telemetry budget. It never participates in playback or business state. */
export class DramaTimingProcessor {
  private readonly queue: TimingJob[] = [];
  private readonly active = new Set<Promise<void>>();
  private closing = false;

  constructor(
    private readonly repository: DramaTimingRepository,
    private readonly context: { environment: string; release: string }
  ) {}

  enqueue(report: DramaTimingReport, log: RequestLogger): boolean {
    if (this.closing || this.queue.length >= MAX_QUEUED) return false;
    this.queue.push({ report, log, enqueuedAt: performance.now() });
    this.pump();
    return true;
  }

  stats(): { active: number; queued: number } {
    return { active: this.active.size, queued: this.queue.length };
  }

  async close(): Promise<void> {
    this.closing = true;
    const dropped = this.queue.splice(0);
    for (const job of dropped) {
      try {
        job.log.sys.warn(
          {
            event: 'drama.timing_dropped',
            observation_id: job.report.id,
            reason: 'shutdown',
          },
          'drama timing dropped during shutdown'
        );
      } catch {
        // A broken diagnostic sink must not prevent bounded shutdown.
      }
    }
    await Promise.allSettled([...this.active]);
  }

  private pump(): void {
    if (this.closing) return;
    while (this.active.size < MAX_CONCURRENCY) {
      const job = this.queue.shift();
      if (!job) return;
      let task: Promise<void>;
      task = this.process(job)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(task);
          this.pump();
        });
      this.active.add(task);
    }
  }

  private async process(job: TimingJob): Promise<void> {
    const startedAt = performance.now();
    try {
      const result = await this.repository.persist(job.report, this.context);
      job.log.biz.info(
        {
          event: 'drama.timing_persisted',
          observation_id: job.report.id,
          phase: job.report.phase,
          result,
          queue_ms: startedAt - job.enqueuedAt,
          elapsed_ms: performance.now() - startedAt,
          environment: this.context.environment,
          server_release: this.context.release,
        },
        'drama timing persisted'
      );
    } catch (err) {
      job.log.sys.error(
        {
          err,
          event: 'drama.timing_persist_failed',
          observation_id: job.report.id,
          queue_ms: startedAt - job.enqueuedAt,
          elapsed_ms: performance.now() - startedAt,
        },
        'drama timing persistence failed'
      );
    }
  }
}
