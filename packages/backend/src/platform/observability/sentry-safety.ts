import type { Breadcrumb, Event, Log, StackFrame } from '@sentry/node';
import { safeName } from './events.js';
import { safeLogRecord, safeLogAttributes } from './safe-log.js';
import { withoutBusinessIds } from './business-context.js';

function safeFrame(frame: StackFrame): StackFrame {
  const filename = frame.filename?.split(/[\\/]/).pop()?.split('?')[0];
  return {
    filename: filename && /^[\w.-]+\.[cm]?[jt]s$/.test(filename) ? filename : 'unknown',
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
}

export function safeSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    timestamp: breadcrumb.timestamp,
    type: breadcrumb.type,
    level: breadcrumb.level,
    category: safeName(breadcrumb.category),
    message: 'Breadcrumb details withheld',
    data: breadcrumb.data ? withoutBusinessIds(safeLogRecord(breadcrumb.data)) : undefined,
  };
}

/** SDK auto-capture is a separate output boundary; request bodies and exception text are unsafe. */
export function safeSentryEvent<T extends Event>(event: T): T {
  const result = { ...event };
  delete result.user;
  delete result.request;
  delete result.extra;
  delete result.logentry;
  delete result.fingerprint;
  if (event.fingerprint?.[0] === 'background-job' && event.fingerprint.length === 2)
    result.fingerprint = ['background-job', safeName(event.fingerprint[1])];
  result.message = event.message ? 'Backend event details withheld' : undefined;
  result.tags = event.tags
    ? (withoutBusinessIds(safeLogRecord(event.tags)) as Event['tags'])
    : undefined;
  const trace = event.contexts?.trace;
  result.contexts = trace
    ? {
        trace: {
          trace_id: trace.trace_id,
          span_id: trace.span_id,
          parent_span_id: trace.parent_span_id,
          op: trace.op,
          status: trace.status,
        },
      }
    : undefined;
  // SDK route templates retain per-route performance grouping; arbitrary captured URLs do not.
  result.transaction =
    event.transaction && event.transaction_info?.source === 'route'
      ? event.transaction.split('?')[0]?.slice(0, 160)
      : event.transaction
        ? 'backend.request'
        : undefined;
  result.breadcrumbs = event.breadcrumbs?.map(safeSentryBreadcrumb);
  result.exception = event.exception
    ? {
        values: event.exception.values?.map((value) => ({
          type: safeName(value.type, 'Error'),
          value: 'Error details withheld; inspect source locations',
          mechanism: value.mechanism
            ? { type: safeName(value.mechanism.type), handled: value.mechanism.handled }
            : undefined,
          stacktrace: value.stacktrace
            ? { frames: value.stacktrace.frames?.slice(-30).map(safeFrame) }
            : undefined,
        })),
      }
    : undefined;
  result.spans = event.spans?.map((span) => ({
    ...span,
    description: 'Backend operation',
    data: withoutBusinessIds(safeLogAttributes(span.data ?? {})),
  }));
  return result;
}

export function safeSentryLog(log: Log): Log {
  return {
    ...log,
    message: safeName(log.message, 'Backend log'),
    attributes: log.attributes
      ? (withoutBusinessIds(safeLogRecord(log.attributes)) as Log['attributes'])
      : undefined,
  };
}
