import { safeError, safeName } from './events.js';

/** Deployment/project dictionaries are injected; this factory has no app or locale dependency. */
export interface LogPresentationCatalog {
  modules: Readonly<Record<string, string>>;
  scenes: Readonly<Record<string, string>>;
  events: Readonly<Record<string, string>>;
  results: Readonly<Record<string, string>>;
  errors: Readonly<Record<string, string>>;
  details: Readonly<Record<string, string>>;
  counts: Readonly<Record<string, string>>;
  fallback: { module: string; scene: string; result: string; error: string };
}

export interface LogPresentation {
  msg: string;
  module_name: string;
  scenario: string;
  result: string;
  error_message?: string;
}

function code(value: unknown): string | undefined {
  const name = safeName(value, '');
  return name || undefined;
}

function lookup(table: Readonly<Record<string, string>>, value: unknown): string | undefined {
  const key = code(value);
  return key && Object.hasOwn(table, key) ? table[key] : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : undefined;
}

function resultCode(record: Record<string, unknown>, level: number): string {
  const event = code(record.event) ?? '';
  if (event === 'operation.started') return 'pending';
  if (code(record.outcome)) return code(record.outcome)!;
  if (/\.(?:failed|error|deadline_exceeded)$/.test(event) || level >= 50) return 'failed';
  if (/\.(?:skipped|guarded|overlap|check_skipped)$/.test(event)) return 'skipped';
  // An info-level event is a recorded fact, never implicit proof of business success.
  return 'recorded';
}

function errorMessage(
  record: Record<string, unknown>,
  catalog: LogPresentationCatalog,
  result: string,
  level: number
): string | undefined {
  for (const value of [record.error_code, record.errorClass]) {
    const known = lookup(catalog.errors, value);
    if (known) return known;
  }
  const raw = record.err ?? record.error;
  if (raw !== undefined) {
    let error = safeError(raw);
    for (let depth = 0; depth < 3; depth++) {
      const known = lookup(catalog.errors, error.code) ?? lookup(catalog.errors, error.type);
      if (known) return known;
      if (!error.cause) break;
      error = error.cause;
    }
  }
  for (const value of [record.public_error_code, record.code, result]) {
    const known = lookup(catalog.errors, value);
    if (known) return known;
  }
  const status = numeric(record.upstream_status) ?? numeric(record.http_status);
  if (status !== undefined && status >= 400) {
    const known =
      lookup(catalog.errors, String(status)) ??
      lookup(catalog.errors, `${Math.floor(status / 100)}xx`);
    if (known) return known;
  }
  return raw !== undefined || level >= 50 || ['failed', 'timed_out', 'interrupted'].includes(result)
    ? catalog.fallback.error
    : undefined;
}

/** Only catalog text and bounded machine metadata enter the headline; caller msg is never used. */
export function createLogPresentation(catalog: LogPresentationCatalog) {
  return (record: Record<string, unknown>, level = 30): LogPresentation => {
    const module =
      lookup(catalog.modules, record.module) ?? code(record.module) ?? catalog.fallback.module;
    const business = lookup(catalog.modules, record.business_module);
    const module_name = business && business !== module ? `${business}·${module}` : module;
    const operation = code(record.operation);
    const event = code(record.event);
    const invocation = code(record.call_scene);
    const scene = lookup(catalog.scenes, invocation) ?? invocation;
    const action =
      event === 'operation.started' || event === 'operation.terminal'
        ? (lookup(catalog.scenes, operation) ?? operation ?? lookup(catalog.events, event))
        : (lookup(catalog.events, event) ?? lookup(catalog.scenes, operation));
    const scenario =
      [scene, action]
        .filter((value, index, all) => value && all.indexOf(value) === index)
        .join(' / ') ||
      invocation ||
      operation ||
      event ||
      catalog.fallback.scene;
    const outcome = resultCode(record, level);
    const result = lookup(catalog.results, outcome) ?? catalog.fallback.result;
    const error_message = errorMessage(record, catalog, outcome, level);
    const details: string[] = [];
    for (const field of [
      'probe_result',
      'paymentType',
      'provider',
      'reason',
      'resource',
      'stage',
    ] as const) {
      const value = lookup(catalog.details, record[field]);
      if (value) details.push(value);
    }
    for (const [field, label] of Object.entries(catalog.counts)) {
      const value = numeric(record[field]);
      if (value !== undefined) details.push(`${label}:${Math.round(value)}`);
    }
    const http = numeric(record.http_status),
      upstream = numeric(record.upstream_status);
    if (http !== undefined) details.push(`HTTP ${Math.round(http)}`);
    if (upstream !== undefined) details.push(`upstream ${Math.round(upstream)}`);
    const duration = numeric(record.duration_ms ?? record.durationMs);
    if (duration !== undefined) details.push(`${Math.round(duration)}ms`);
    const errorCode = code(record.public_error_code ?? record.error_code);
    if (error_message) details.unshift(error_message);
    if (errorCode) details.push(errorCode);
    return {
      msg: [`[${module_name}] ${scenario}`, result, ...details].join('｜').slice(0, 700),
      module_name: module_name.slice(0, 120),
      scenario: scenario.slice(0, 320),
      result,
      ...(error_message ? { error_message } : {}),
    };
  };
}
