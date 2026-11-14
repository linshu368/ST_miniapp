import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { newContext, withContext } from './context.js';
import type { createObserver, Operation } from './core.js';
import type { EventFields } from './events.js';
import { httpBusinessFields } from './http-business.js';

interface RequestObservation {
  operation: Operation;
  error?: unknown;
  publicCode?: string;
  failedEnvelope?: boolean;
  streaming?: boolean;
}

function responseSummary(
  payload: unknown
): Pick<RequestObservation, 'publicCode' | 'failedEnvelope'> {
  if (!payload || typeof payload !== 'object') return {};
  const envelope = payload as { success?: unknown; error?: unknown };
  if (envelope.success !== false) return {};
  const error = envelope.error;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return { failedEnvelope: true, ...(typeof code === 'string' ? { publicCode: code } : {}) };
}

function terminalFields(
  state: RequestObservation,
  reply: FastifyReply,
  interrupted: boolean
): EventFields {
  const status = reply.raw.headersSent ? reply.raw.statusCode : null;
  const streaming =
    state.streaming ||
    String(reply.raw.getHeader('content-type') ?? '').includes('text/event-stream');
  if (interrupted)
    return {
      http_status: status,
      outcome: 'interrupted',
      outcome_known: false,
      error_code: 'REQUEST_INTERRUPTED',
      stage: 'connection_closed',
    };
  // An HTTP stream ending or a webhook ACK is a transport fact, not proof of business success.
  const failed = status !== null && status >= 500;
  const rejected = status !== null && status >= 400;
  return {
    http_status: status,
    outcome: failed
      ? 'failed'
      : rejected
        ? 'rejected'
        : streaming || state.failedEnvelope
          ? 'unknown'
          : 'succeeded',
    outcome_known: !streaming && (!state.failedEnvelope || rejected),
    public_error_code: state.publicCode,
    stage: 'http_response',
    ...(state.error !== undefined ? { err: state.error } : {}),
  };
}

function finishResponse(
  state: RequestObservation,
  request: FastifyRequest,
  reply: FastifyReply,
  interrupted: boolean
): void {
  const fields = terminalFields(state, reply, interrupted);
  const rejected =
    fields.outcome === 'rejected' && [401, 403, 409, 429].includes(fields.http_status ?? 0);
  state.operation.finish(
    { ...fields, route: request.routeOptions.url ?? 'unmatched' },
    rejected ? 'warn' : undefined
  );
}

function attachCompletion(
  state: RequestObservation,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const finish = (interrupted: boolean) => {
    reply.raw.removeListener('finish', complete);
    reply.raw.removeListener('close', close);
    finishResponse(state, request, reply, interrupted);
  };
  const complete = () => finish(false);
  const close = () => finish(!reply.raw.writableFinished);
  reply.raw.once('finish', complete);
  reply.raw.once('close', close);
}

/** Root registration precedes CORS/auth/routes, including replies which bypass onResponse. */
export function registerHttpObservation(
  app: FastifyInstance,
  observer: ReturnType<typeof createObserver>
): void {
  const states = new WeakMap<FastifyRequest, RequestObservation>();
  app.addHook('onRequest', (request, reply, done) => {
    const context = newContext(request.id);
    Object.assign(context.business!, httpBusinessFields(request));
    const state: RequestObservation = {
      operation: observer.start(
        'http.request',
        {
          method: request.method,
          route: request.routeOptions.url ?? 'unmatched',
        },
        context
      ),
    };
    states.set(request, state);
    reply.header('X-Request-Id', context.request_id);
    reply.header('X-Trace-Id', context.trace_id);
    attachCompletion(state, request, reply);
    // Callback hook deliberately continues inside run; async hooks would end this scope too early.
    withContext(context, done);
  });
  app.addHook('preSerialization', async (request, _reply, payload) => {
    const state = states.get(request);
    if (state) Object.assign(state, responseSummary(payload));
    return payload;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const state = states.get(request);
    if (state)
      state.streaming = String(reply.getHeader('content-type') ?? '').includes('text/event-stream');
    return payload;
  });
  app.addHook('onError', async (request, _reply, error) => {
    const state = states.get(request);
    if (state) state.error = error;
  });
  app.addHook('onResponse', async (request, reply) => {
    const state = states.get(request);
    if (state) finishResponse(state, request, reply, false);
  });
  app.addHook('onTimeout', async (request, reply) => {
    states.get(request)?.operation.finish({
      http_status: reply.raw.headersSent ? reply.raw.statusCode : null,
      outcome: 'timed_out',
      outcome_known: false,
      error_code: 'REQUEST_READ_TIMEOUT',
    });
  });
  app.addHook('onRequestAbort', async (request) => {
    states
      .get(request)
      ?.operation.finish({ outcome: 'interrupted', outcome_known: false, http_status: null });
  });
}
