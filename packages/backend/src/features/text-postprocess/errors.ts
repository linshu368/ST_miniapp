import {
  TEXT_POSTPROCESS_MUTATION_ERROR_CODES,
  type TextPostprocessDiagnostic,
  type TextPostprocessMutationErrorCode,
} from '@miniapp/shared';

const MUTATION_CODES = new Set<string>(TEXT_POSTPROCESS_MUTATION_ERROR_CODES);

const MESSAGES: Record<TextPostprocessMutationErrorCode, string> = {
  invalid_source: 'The text postprocess source is invalid.',
  invalid_draft: 'The text postprocess draft is invalid.',
  compile_rejected: 'The text postprocess source failed validation.',
  cas_conflict: 'The draft or published version changed. Reload and try again.',
  request_id_conflict: 'This request id was already used with different content.',
  draft_revision_mismatch: 'The publish target does not match the saved draft.',
  target_version_unavailable: 'The requested published version is unavailable.',
  policy_unsupported: 'The snapshot policy is no longer supported.',
  forbidden: 'Admin access is required.',
};

export class TextPostprocessRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly diagnostics: TextPostprocessDiagnostic[] = []
  ) {
    super(message);
    this.name = 'TextPostprocessRequestError';
  }
}

export function mutationError(
  code: TextPostprocessMutationErrorCode,
  diagnostics: TextPostprocessDiagnostic[] = [],
  statusCode = statusForMutation(code)
): TextPostprocessRequestError {
  return new TextPostprocessRequestError(statusCode, code, MESSAGES[code], diagnostics);
}

export function statusForMutation(code: TextPostprocessMutationErrorCode): number {
  switch (code) {
    case 'forbidden':
      return 403;
    case 'cas_conflict':
    case 'request_id_conflict':
    case 'draft_revision_mismatch':
      return 409;
    case 'target_version_unavailable':
      return 404;
    case 'policy_unsupported':
      return 422;
    default:
      return 400;
  }
}

export interface RpcFailure {
  code?: string | null;
  message?: string | null;
}

/**
 * 只认我们自己写进 SQL 的前缀和 SQLSTATE。其余消息不返回给客户端。
 * 五位 SQLSTATE 表示事务已经结束；没有 SQLSTATE 的传输失败才需要再查 request_id。
 */
export function mapTextPostprocessRpcError(
  error: RpcFailure
): TextPostprocessMutationErrorCode | null {
  const prefix = (error.message ?? '').split(':', 1)[0]?.trim() ?? '';
  if (MUTATION_CODES.has(prefix)) return prefix as TextPostprocessMutationErrorCode;
  if (error.code === '40001') return 'cas_conflict';
  if (error.code === '42501') return 'forbidden';
  if (error.code === 'P0002' && (error.message ?? '').includes('target_version_unavailable')) {
    return 'target_version_unavailable';
  }
  if (error.code === 'P0002' && (error.message ?? '').includes('invalid_draft'))
    return 'invalid_draft';
  return null;
}

export function isDefiniteDatabaseError(error: RpcFailure): boolean {
  const code = error.code ?? '';
  return /^[0-9A-Z]{5}$/.test(code) || code === 'PGRST202';
}

export function safeTextPostprocessError(error: unknown): Error {
  if (error instanceof TextPostprocessRequestError) return error;
  const safe = new Error('text postprocess request failed');
  safe.name = 'TextPostprocessRequestError';
  return safe;
}
