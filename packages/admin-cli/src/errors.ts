import { TextPostprocessClientError } from '@miniapp/admin-client';

/**
 * 稳定的错误码与退出码。AI 助手按 code / 退出码分支处理，文案只给人看，
 * 所以新增分类只能追加，不能改已有含义。
 */
export const EXIT_CODES = {
  usage: 1,
  validation_failed: 1,
  not_found: 1,
  setup_required: 2,
  auth_required: 2,
  permission_denied: 3,
  conflict: 4,
  draft_exists: 4,
  confirmation_required: 5,
  unavailable: 6,
  unknown: 7,
} as const;

export type ErrorCode = keyof typeof EXIT_CODES;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

// 数据库 RAISE 文案和 supabase-js / fetch 的报错是唯一能拿到的失败原因，按关键片段归类。
const AUTH_PATTERNS = [
  'jwt',
  'refresh token',
  'refresh_token',
  'auth session missing',
  'invalid login credentials',
  '登录状态已失效',
];
const PERMISSION_PATTERNS = [
  'viewer accounts are read-only',
  'not permitted',
  'registered admin required',
  'permission denied',
  'insufficient_privilege',
  '没有当前环境',
];
const CONFLICT_PATTERNS = [
  'config changed after draft creation',
  'already been published',
  'layout version',
  'layout changed',
  'stale',
  'conflict',
];
const NOT_FOUND_PATTERNS = ['not found', '不存在'];
const UNAVAILABLE_PATTERNS = [
  'fetch failed',
  'network',
  'timeout',
  'timed out',
  'aborted',
  'econnreset',
  'econnrefused',
  'enotfound',
  'socket hang up',
  '暂时不可用',
  '无法连接',
];

function matches(message: string, patterns: readonly string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

export function classifyError(error: unknown): CliError {
  if (error instanceof CliError) return error;

  if (error instanceof TextPostprocessClientError) {
    const details = { kind: error.kind, code: error.code, diagnostics: error.diagnostics };
    if (error.kind === 'unauthorized') return new CliError('auth_required', error.message, details);
    if (error.kind === 'forbidden' || error.code === 'forbidden') {
      return new CliError('permission_denied', error.message, details);
    }
    if (error.kind === 'transport' || error.kind === 'result_unknown') {
      return new CliError('unavailable', error.message, details);
    }
    if (
      error.code === 'cas_conflict' ||
      error.code === 'draft_revision_mismatch' ||
      error.code === 'request_id_conflict'
    ) {
      return new CliError('conflict', error.message, details);
    }
    if (error.kind === 'mutation') return new CliError('validation_failed', error.message, details);
    return new CliError('unknown', error.message, details);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (matches(message, PERMISSION_PATTERNS)) return new CliError('permission_denied', message);
  if (matches(message, AUTH_PATTERNS)) {
    return new CliError('auth_required', `${message}。请本人在终端执行：pnpm admin login`);
  }
  if (matches(message, CONFLICT_PATTERNS)) return new CliError('conflict', message);
  if (matches(message, UNAVAILABLE_PATTERNS)) return new CliError('unavailable', message);
  if (matches(message, NOT_FOUND_PATTERNS)) return new CliError('not_found', message);
  return new CliError('unknown', message);
}
