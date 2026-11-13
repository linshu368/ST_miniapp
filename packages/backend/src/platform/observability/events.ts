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
  code?: string;
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

/** Recognized database/network code formats only; never infer codes from private messages. */
export function safeErrorCode(error: unknown): string | undefined {
  try {
    const code =
      error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' &&
      /^(?:(?:[0-9][0-9A-Z]|[FPX][0-9A-Z])[0-9A-Z]{3}|P[0-9]{4}|PGRST[0-9]{3}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ABORT_ERR|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(
        code
      )
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

/** Error.message, SDK detail and cause text can contain credentials or user content. */
export function safeError(error: unknown, depth = 0): SafeError {
  try {
    if (!error || typeof error !== 'object') return { type: 'Error', message: 'Non-error failure' };
    const source = error as { type?: unknown; stack?: unknown; cause?: unknown };
    // Already projected foundation errors use type; SDK objects may only carry code.
    const name = error instanceof Error ? error.name : source.type;
    const type = typeof name === 'string' && ERROR_TYPES.has(name) ? name : 'Error';
    const code = safeErrorCode(error);
    // Preserve source locations, not the first message line, URL, absolute path or function arguments.
    const frames = (typeof source.stack === 'string' ? source.stack : '')
      .slice(0, 16_384)
      .split('\n')
      .slice(1, 13)
      .map((line) => /(?:^at\s+|[/\\])([\w.-]+\.[cm]?[jt]s):(\d+):(\d+)\)?$/.exec(line.trim()))
      .filter((frame) => frame !== null)
      .map((frame) => `    at ${frame[1]}:${frame[2]}:${frame[3]}`);
    return {
      type,
      message: 'Error details withheld; inspect error_code and source locations',
      ...(code ? { code } : {}),
      ...(frames.length ? { stack: `${type}\n${frames.join('\n')}` } : {}),
      ...(source.cause !== undefined && depth < 2
        ? { cause: safeError(source.cause, depth + 1) }
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
