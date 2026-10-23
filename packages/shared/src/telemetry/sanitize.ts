const REDACTED = '[Filtered]';
const TRUNCATED = '[Truncated]';

// 脱敏跑在 Sentry 的 beforeSend / Replay 回调里，输入体量不可控（回放的 DOM 快照可以非常深）。
// 不设上限会在移动 WebView 上递归爆栈，事件被整个丢掉。
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 20_000;

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
  /([?&#](?:authorization|token|access_token|refresh_token|id_token|secret|password|x-init-data|rawInitData|tgWebAppData)=)[^&#\s]*/gi;

export interface SanitizeTelemetryOptions {
  /** 超过该深度后的处理方式由 `beyondLimit` 决定。 */
  maxDepth?: number;
  maxNodes?: number;
  /**
   * `truncate`（默认）：超限部分替换成 `[Truncated]`，适合事件/面包屑。
   * `passthrough`：超限部分原样保留，不再递归。适合 Replay 录制事件——替换会破坏回放的 DOM 结构。
   */
  beyondLimit?: 'truncate' | 'passthrough';
}

interface SanitizeState {
  maxDepth: number;
  nodesLeft: number;
  beyondLimit: 'truncate' | 'passthrough';
}

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
  seen: WeakMap<object, unknown>,
  depth: number,
  state: SanitizeState
): unknown {
  if (key && isSensitiveTelemetryKey(key)) return REDACTED;
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (depth >= state.maxDepth || state.nodesLeft <= 0) {
    return state.beyondLimit === 'passthrough' ? value : TRUNCATED;
  }
  state.nodesLeft -= 1;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitizeValue(item, undefined, seen, depth + 1, state));
    return copy;
  }

  if (value instanceof Date || value instanceof Error) return value;

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [childKey, childValue] of Object.entries(value)) {
    copy[childKey] = sanitizeValue(childValue, childKey, seen, depth + 1, state);
  }
  return copy;
}

export function sanitizeTelemetry<T>(value: T, options: SanitizeTelemetryOptions = {}): T {
  const state: SanitizeState = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    nodesLeft: options.maxNodes ?? DEFAULT_MAX_NODES,
    beyondLimit: options.beyondLimit ?? 'truncate',
  };
  return sanitizeValue(value, undefined, new WeakMap(), 0, state) as T;
}
