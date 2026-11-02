import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

/** Request-local timestamps only; no headers, body, address or database writes. */
export interface UpstreamTiming {
  startedAt: number;
  requestCreatedMs?: number;
  sendHeadersMs?: number;
  bodySentMs?: number;
  responseHeadersMs?: number;
}

const context = new AsyncLocalStorage<{ timing: UpstreamTiming; active: boolean }>();
const requests = new WeakMap<object, { timing: UpstreamTiming; active: boolean }>();
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  for (const [name, field] of [
    ['undici:request:create', 'requestCreatedMs'],
    ['undici:client:sendHeaders', 'sendHeadersMs'],
    ['undici:request:bodySent', 'bodySentMs'],
    ['undici:request:headers', 'responseHeadersMs'],
  ] as const) {
    channel(name).subscribe((message: unknown) => {
      // Diagnostics subscribers run inside fetch. They must never throw or await.
      try {
        if (!message || typeof message !== 'object' || !('request' in message)) return;
        const request = message.request;
        if (!request || typeof request !== 'object') return;
        const current = field === 'requestCreatedMs' ? context.getStore() : requests.get(request);
        if (!current?.active) return;
        if (field === 'requestCreatedMs') requests.set(request, current);
        current.timing[field] ??= Math.max(0, performance.now() - current.timing.startedAt);
      } catch {
        /* Optional diagnostics must not interfere with fetch. */
      }
    });
  }
}

export async function withUpstreamTiming<T>(
  timing: UpstreamTiming | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (!timing) return work();
  subscribe();
  const state = { timing, active: true };
  try {
    return await context.run(state, work);
  } finally {
    state.active = false;
  }
}
