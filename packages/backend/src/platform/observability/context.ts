import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { safeBusinessFields, type BusinessFields } from './business-context.js';
import { safeName } from './events.js';

export interface ObservationContext {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  request_id?: string;
  /** Stable registered HTTP route or job operation; never an incoming URL or user text. */
  call_scene?: string;
  /** Per-root metadata is enriched after auth; spans keep their immutable trace identity. */
  business?: BusinessFields;
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
    business: {},
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

export function bindBusinessContext(fields: BusinessFields): void {
  const business = currentContext()?.business;
  if (business) Object.assign(business, safeBusinessFields(fields));
}

/** Different entities processed concurrently must not mutate the request/job parent's metadata. */
export function withBusinessContext<T>(fields: BusinessFields, run: () => T): T {
  const context = currentContext() ?? newContext();
  return withContext(
    { ...context, business: { ...context.business, ...safeBusinessFields(fields) } },
    run
  );
}

export function contextLogFields(
  context: ObservationContext
): Omit<ObservationContext, 'business'> & BusinessFields;
export function contextLogFields(): Partial<Omit<ObservationContext, 'business'>> & BusinessFields;
export function contextLogFields(context = currentContext()) {
  if (!context) return {};
  const { business, call_scene, ...trace } = context;
  return {
    ...safeBusinessFields(business ?? {}),
    ...trace,
    ...(call_scene ? { call_scene: safeName(call_scene) } : {}),
  };
}
