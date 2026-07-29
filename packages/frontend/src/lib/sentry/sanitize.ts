const REDACTED = '[Filtered]';

const SENSITIVE_KEY_NAMES = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'password',
  'xinitdata',
  'rawinitdata',
  'tgwebappdata',
]);

const SENSITIVE_QUERY_PARAM =
  /([?&](?:authorization|token|access_token|refresh_token|id_token|secret|password|x-init-data|rawInitData|tgWebAppData)=)[^&#\s]*/gi;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveTelemetryKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeKey(key));
}

function sanitizeString(value: string): string {
  return value.replace(SENSITIVE_QUERY_PARAM, `$1${REDACTED}`);
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  seen: WeakMap<object, unknown>
): unknown {
  if (key && isSensitiveTelemetryKey(key)) return REDACTED;
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitizeValue(item, undefined, seen));
    return copy;
  }

  if (value instanceof Date || value instanceof Error) return value;

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [childKey, childValue] of Object.entries(value)) {
    copy[childKey] = sanitizeValue(childValue, childKey, seen);
  }
  return copy;
}

/**
 * Returns a sanitized copy suitable for Sentry events, breadcrumbs and logs.
 * Normal conversation text is intentionally preserved for Session Replay.
 */
export function sanitizeTelemetry<T>(value: T): T {
  return sanitizeValue(value, undefined, new WeakMap()) as T;
}
