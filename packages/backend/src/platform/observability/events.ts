export type Outcome =
  | 'succeeded'
  | 'rejected'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'interrupted'
  | 'degraded'
  | 'skipped'
  | 'unknown'
  | 'pending';
export type EventLevel = 'info' | 'warn' | 'error' | 'fatal';

/** Only explicitly projected metadata crosses an output boundary. Never pass a DTO here. */
export interface EventFields {
  outcome?: Outcome;
  outcome_known?: boolean;
  http_status?: number | null;
  upstream_status?: number | null;
  public_error_code?: string;
  error_code?: string;
  method?: string;
  route?: string;
  stage?: string;
  provider?: string;
  resource?: string;
  business_key?: string;
  attempt?: number;
  duration_ms?: number;
  count?: number;
  config_version?: number;
  err?: unknown;
}

export interface SafeError {
  type: string;
  message: string;
  stack?: string;
  cause?: SafeError;
}

export interface ObservationEvent extends Omit<EventFields, 'err'> {
  schema_version: 1;
  event_id: string;
  event: string;
  module: string;
  operation: string;
  kind: 'sys';
  level: EventLevel;
  timestamp: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  request_id?: string;
  err?: SafeError;
}

const OUTCOMES = new Set<Outcome>([
  'succeeded',
  'rejected',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
  'degraded',
  'skipped',
  'unknown',
  'pending',
]);
const ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'AggregateError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
]);

export function safeName(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : fallback;
}

/** Error.message, SDK detail and cause text can contain credentials or user content. */
export function safeError(error: unknown, depth = 0): SafeError {
  try {
    if (!(error instanceof Error)) return { type: 'Error', message: 'Non-error failure' };
    const type = ERROR_TYPES.has(error.name) ? error.name : 'Error';
    // Preserve source locations, not the first message line, URL, absolute path or function arguments.
    const frames = (error.stack ?? '')
      .slice(0, 16_384)
      .split('\n')
      .slice(1, 13)
      .map((line) => /(?:[/\\])([\w.-]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/.exec(line.trim()))
      .filter((frame) => frame !== null)
      .map((frame) => `    at ${frame[1]}:${frame[2]}:${frame[3]}`);
    return {
      type,
      message: 'Error details withheld; inspect error_code and source locations',
      ...(frames.length ? { stack: `${type}\n${frames.join('\n')}` } : {}),
      ...(error.cause !== undefined && depth < 2
        ? { cause: safeError(error.cause, depth + 1) }
        : {}),
    };
  } catch {
    return { type: 'Error', message: 'Unreadable error' };
  }
}

export function safeFields(fields: EventFields): Omit<EventFields, 'err'> & { err?: SafeError } {
  const result: Omit<EventFields, 'err'> & { err?: SafeError } = {};
  for (const key of [
    'error_code',
    'public_error_code',
    'method',
    'route',
    'stage',
    'provider',
    'resource',
    'business_key',
  ] as const) {
    if (fields[key] !== undefined) result[key] = safeName(fields[key]);
  }
  for (const key of ['duration_ms', 'attempt', 'count', 'config_version'] as const) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      result[key] = Math.min(value, Number.MAX_SAFE_INTEGER);
  }
  for (const key of ['http_status', 'upstream_status'] as const) {
    const value = fields[key];
    if (value === null || (Number.isInteger(value) && value! >= 100 && value! <= 599))
      result[key] = value;
  }
  if (fields.outcome && OUTCOMES.has(fields.outcome)) result.outcome = fields.outcome;
  if (typeof fields.outcome_known === 'boolean') result.outcome_known = fields.outcome_known;
  if (fields.err !== undefined) result.err = safeError(fields.err);
  return result;
}

export function outcomeLevel(outcome?: Outcome): EventLevel {
  if (outcome === 'failed') return 'error';
  if (outcome && ['timed_out', 'interrupted', 'degraded', 'unknown'].includes(outcome))
    return 'warn';
  return 'info';
}
