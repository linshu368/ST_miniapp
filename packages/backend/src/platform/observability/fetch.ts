import { withContext } from './context.js';
import type { createObserver } from './core.js';
import { observation } from './runtime.js';
import type { EventFields } from './events.js';

/** One transport attempt, through response headers only. The caller still owns body/deadline/retry. */
export function createObservedFetch(observer: ReturnType<typeof createObserver>) {
  return async function observedFetch(
    operation: string,
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
    fields: Pick<EventFields, 'provider' | 'resource'> = {},
    execute: typeof fetch = globalThis.fetch
  ): Promise<Response> {
    const op = observer.start(operation, {
      ...fields,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      stage: 'response_headers',
    });
    return withContext(op.context, async () => {
      try {
        const response = await execute(input, init);
        op.finish(
          {
            upstream_status: response.status,
            outcome: response.ok ? 'succeeded' : 'failed',
            outcome_known: true,
          },
          response.ok ? 'info' : 'warn'
        );
        return response;
      } catch (err) {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const timeout = signal?.reason instanceof Error && signal.reason.name === 'TimeoutError';
        op.finish(
          {
            outcome: timeout ? 'timed_out' : signal?.aborted ? 'cancelled' : 'failed',
            outcome_known: false,
            error_code: timeout
              ? 'UPSTREAM_TIMEOUT'
              : signal?.aborted
                ? 'OPERATION_CANCELLED'
                : 'UPSTREAM_NETWORK_ERROR',
            err,
          },
          'warn'
        );
        throw err;
      }
    });
  };
}

export const observedFetch = createObservedFetch(observation);

/** Explicit client registration, never a global fetch replacement. */
export function clientFetch(operation: string, provider: string): typeof globalThis.fetch {
  return (input, init) => observedFetch(operation, input, init, { provider });
}
