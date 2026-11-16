import { randomUUID } from 'node:crypto';

type ProxyOutcome = 'succeeded' | 'rejected' | 'failed' | 'timed_out' | 'cancelled';
type ProxyErrorCode =
  | 'BAD_REQUEST'
  | 'REQUEST_ABORTED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE';

function boundedRequestId(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

/** Server-only proxy boundary: fixed metadata, never request URLs, bodies or raw errors. */
export function createLobbyProxyObservation(request: Request) {
  const startedAt = performance.now();
  const requestId = boundedRequestId(request.headers.get('x-request-id')) ?? randomUUID();
  let upstreamRequestId: string | undefined;
  let traceId: string | undefined;
  let finished = false;
  return {
    requestId,
    upstream(headers: Headers) {
      upstreamRequestId = boundedRequestId(headers.get('x-request-id'));
      const trace = headers.get('x-trace-id');
      traceId = trace && /^[a-f0-9]{32}$/i.test(trace) ? trace : undefined;
    },
    responseHeaders(initial: HeadersInit = {}) {
      const headers = new Headers(initial);
      headers.set('X-Request-Id', upstreamRequestId ?? requestId);
      if (traceId) headers.set('X-Trace-Id', traceId);
      return headers;
    },
    finish(status: number, outcome: ProxyOutcome, publicCode?: ProxyErrorCode) {
      if (finished) return;
      finished = true;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      try {
        // Next.js has a separate runtime; deployment stdout plus request ID links it to Railway.
        console[level](
          JSON.stringify({
            schema_version: 1,
            event_id: randomUUID(),
            event: 'lobby.proxy.terminal',
            operation: 'lobby.proxy',
            module: 'lobby',
            source: 'frontend-next-proxy',
            level,
            request_id: requestId,
            ...(upstreamRequestId ? { upstream_request_id: upstreamRequestId } : {}),
            ...(traceId ? { trace_id: traceId } : {}),
            outcome,
            http_status: status,
            ...(publicCode ? { public_error_code: publicCode } : {}),
            duration_ms: Math.max(0, performance.now() - startedAt),
          })
        );
      } catch {
        // An unavailable log output cannot change the catalogue or its cache policy.
      }
    },
  };
}
