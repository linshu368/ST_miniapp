import { AsyncLocalStorage } from 'node:async_hooks';
import { newContext, withContext } from './context.js';
import type { createObserver, Operation } from './core.js';
import type { EventFields } from './events.js';

/** Each factory owns its job reporters; importing this module never starts an application. */
export function createJobObservation(observer: ReturnType<typeof createObserver>) {
  const jobs = new AsyncLocalStorage<{ job: string; operation: Operation }>();
  return {
    hasBackgroundOperation(job: string): boolean {
      return jobs.getStore()?.job === job;
    },
    finishBackgroundOperation(job: string, fields: EventFields): void {
      const current = jobs.getStore();
      if (current?.job === job) current.operation.finish(fields);
    },
    async runObservedJob<T>(job: string, run: () => Promise<T>): Promise<T> {
      const operation = observer.start(`job.${job}`, {}, newContext());
      return jobs.run({ job, operation }, () =>
        withContext(operation.context, async () => {
          try {
            return await run();
          } catch (err) {
            operation.finish({ outcome: 'failed', outcome_known: false, err });
            throw err;
          } finally {
            // Resolved void is not proof of success; the actual reporter owns completion.
            operation.finish({ outcome: 'unknown', outcome_known: false });
          }
        })
      );
    },
  };
}
