import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as Sentry from '@sentry/node';
import { logger } from './logger.js';

const SLOW_MS = 1_000;
const CHAT_ROUTES = new Set([
  '/api/v1/conversations/:id/messages',
  '/api/v1/conversations/:id/regenerate',
]);
// Only known database object names, never caller-controlled paths or query strings.
const REST_RESOURCES = new Set([
  'runtime_config',
  'users',
  'chat_sessions',
  'session_chat_history',
  'chat_history',
  'chat_generation_requests',
  'chat_generation_attempts',
  'get_chat_context_before_turn',
  'start_chat_history_turn_with_current_postprocess',
  'start_chat_history_regeneration_with_current_postprocess',
  'begin_chat_generation_observation',
  'prepare_chat_generation_fallback',
  'observe_chat_generation_attempt',
  'select_chat_generation_delivery',
]);

type Outcome = 'ok' | 'error' | 'aborted' | 'pending';
type Stage = 'before_body' | 'body_parse' | 'validation' | 'pre_handler';
type RequestTiming = {
  started: number;
  last: number;
  stage: Stage;
  stages: Partial<Record<Stage, number>>;
};

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Diagnostics must not replace a business result, even when the sink fails.
  }
}

function duration(stage: string, ms: number, outcome: Outcome, method: string): void {
  safely(() =>
    Sentry.metrics.distribution('prep.dependency.duration', ms, {
      unit: 'millisecond',
      attributes: { stage, outcome, method },
    })
  );
}

/** Measures only application lifecycle boundaries, not time before Fastify receives the request. */
export function registerPreparationDiagnostics(app: FastifyInstance): void {
  const timings = new WeakMap<FastifyRequest, RequestTiming>();
  const advance = (request: FastifyRequest, next?: Stage, outcome: Outcome = 'ok') => {
    const timing = timings.get(request);
    if (!timing) return;
    const now = performance.now();
    const elapsed = Math.max(0, now - timing.last);
    timing.stages[timing.stage] = elapsed;
    duration(timing.stage, elapsed, outcome, request.method);
    if (next) {
      timing.stage = next;
      timing.last = now;
      return;
    }
    timings.delete(request);
    if (now - timing.started >= SLOW_MS || outcome !== 'ok')
      safely(() => {
        request.log.info(
          {
            kind: 'sys',
            event: 'conversation.request_preparation',
            route: request.routeOptions.url,
            outcome,
            stage: timing.stage,
            duration_ms: Math.round(now - timing.started),
            stages_ms: timing.stages,
          },
          'Conversation request preparation diagnostic'
        );
      });
  };
  app.addHook('onRequest', async (request) => {
    if (request.method !== 'POST' || !CHAT_ROUTES.has(request.routeOptions.url ?? '')) return;
    const started = performance.now();
    timings.set(request, { started, last: started, stage: 'before_body', stages: {} });
  });
  app.addHook('preParsing', async (request, _reply, payload) => {
    advance(request, 'body_parse');
    return payload;
  });
  app.addHook('preValidation', async (request) => {
    advance(request, 'validation');
  });
  app.addHook('preHandler', async (request) => {
    advance(request, 'pre_handler');
  });
  // A global preHandler runs BEFORE route auth. Append to the route chain to include auth.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.includes('POST') || !CHAT_ROUTES.has(route.url)) return;
    const existing = route.preHandler;
    route.preHandler = [
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
      async (request) => {
        advance(request);
      },
    ];
  });
  app.addHook('onError', async (request) => {
    advance(request, undefined, 'error');
  });
  app.addHook('onRequestAbort', async (request) => {
    advance(request, undefined, 'aborted');
  });
  app.addHook('onResponse', async (request, reply) => {
    // Auth rejection may short-circuit the appended preHandler; never wait for SSE completion.
    advance(request, undefined, reply.statusCode >= 400 ? 'error' : 'ok');
  });
}

function restIdentity(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const match = /^\/rest\/v1\/(?:rpc\/)?([a-z_]+)$/.exec(url.pathname);
    const name = match?.[1];
    if (!name) return null;
    const resource = REST_RESOURCES.has(name) ? name : 'other';
    const rawMethod = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const method = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(rawMethod)
      ? rawMethod
      : 'other';
    return { resource, method };
  } catch {
    return null;
  }
}

/** Pass through untouched. fetch resolves at HEADERS; this is not SQL or full-body latency. */
export const observedSupabaseFetch: typeof fetch = async (input, init) => {
  const identity = restIdentity(input, init);
  if (!identity) return globalThis.fetch(input, init);
  const started = performance.now();
  let outcome: Outcome = 'error';
  let status: number | undefined;
  const report = (state: Outcome) =>
    safely(() => {
      logger.info(
        {
          kind: 'sys',
          event: 'supabase.rest_wait',
          ...identity,
          stage: 'response_headers',
          outcome: state,
          duration_ms: Math.round(performance.now() - started),
          ...(status === undefined ? {} : { status }),
        },
        'Supabase REST response headers diagnostic'
      );
    });
  // Captures outstanding dependencies too; completed-only metrics miss hanging requests.
  const timer = setTimeout(() => report('pending'), SLOW_MS);
  timer.unref();
  try {
    const response = await globalThis.fetch(input, init);
    status = response.status;
    outcome = response.ok ? 'ok' : 'error';
    return response;
  } catch (error) {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) outcome = 'aborted';
    throw error;
  } finally {
    clearTimeout(timer);
    const elapsed = performance.now() - started;
    duration('supabase_headers', elapsed, outcome, identity.method);
    if (elapsed >= SLOW_MS || outcome !== 'ok') report(outcome);
  }
};
