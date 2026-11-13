import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

export interface ObservationContext {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  request_id?: string;
}

const storage = new AsyncLocalStorage<Readonly<ObservationContext>>();

export function currentContext(): Readonly<ObservationContext> | undefined {
  return storage.getStore();
}

export function requestId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : randomUUID();
}

export function newContext(request?: string): ObservationContext {
  return {
    trace_id: randomBytes(16).toString('hex'),
    span_id: randomBytes(8).toString('hex'),
    ...(request ? { request_id: requestId(request) } : {}),
  };
}

export function childContext(): ObservationContext {
  const parent = currentContext();
  if (!parent) return newContext();
  return { ...parent, parent_span_id: parent.span_id, span_id: randomBytes(8).toString('hex') };
}

export function withContext<T>(context: ObservationContext, run: () => T): T {
  return storage.run(Object.freeze({ ...context }), run);
}
