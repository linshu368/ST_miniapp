import { AsyncLocalStorage } from 'node:async_hooks';
import { newContext, withContext } from './context.js';
import type { Operation } from './core.js';
import type { EventFields } from './events.js';
import { observation } from './runtime.js';

const jobs = new AsyncLocalStorage<{ job: string; operation: Operation }>();

export function hasBackgroundOperation(job: string): boolean {
  return jobs.getStore()?.job === job;
}

export function finishBackgroundOperation(job: string, fields: EventFields): void {
  const current = jobs.getStore();
  if (current?.job === job) current.operation.finish(fields);
}

/** The job's existing result reporter owns completion; resolved void alone is not proof of success. */
export async function runObservedJob<T>(job: string, run: () => Promise<T>): Promise<T> {
  const operation = observation.start(`job.${job}`, {}, newContext());
  return jobs.run({ job, operation }, () =>
    withContext(operation.context, async () => {
      try {
        return await run();
      } catch (err) {
        operation.finish({ outcome: 'failed', outcome_known: false, err });
        throw err;
      } finally {
        operation.finish({ outcome: 'unknown', outcome_known: false });
      }
    })
  );
}
