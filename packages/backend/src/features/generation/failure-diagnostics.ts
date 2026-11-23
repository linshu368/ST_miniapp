import { FirstTokenDeadlineError } from './first-token-fallback.js';

/** Cancellation has to carry a proven owner/reason, rather than just an AbortError name. */
export class GenerationAbortReason extends Error {
  constructor(readonly code: 'USER_STOP' | 'TURN_TERMINAL' | 'EXECUTION_DEADLINE') {
    super(code);
    // Existing execution/observation consumers recognize the overall deadline by this name.
    if (code === 'EXECUTION_DEADLINE') this.name = 'TimeoutError';
  }
}

function belongsToSignal(error: unknown, reason: unknown): boolean {
  return (
    error === reason ||
    (error instanceof Error && error.name === 'AbortError' && error.cause === reason)
  );
}

function classifyGenerationFailure(error: unknown, signal?: AbortSignal) {
  if (
    error instanceof FirstTokenDeadlineError ||
    (signal?.aborted &&
      belongsToSignal(error, signal.reason) &&
      signal.reason instanceof FirstTokenDeadlineError)
  )
    return {
      failure_kind: 'first_token_timeout',
      failed_stage: 'first_token',
      cancel_source: 'deadline',
    };
  if (
    signal?.aborted &&
    belongsToSignal(error, signal.reason) &&
    signal.reason instanceof GenerationAbortReason
  ) {
    if (signal.reason.code === 'USER_STOP')
      return { failure_kind: 'user_stop', cancel_source: 'user_stop' };
    if (signal.reason.code === 'EXECUTION_DEADLINE')
      return { failure_kind: 'dependency_timeout', cancel_source: 'deadline' };
    return { failure_kind: 'unknown', cancel_source: 'turn_terminal' };
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'CHAT_HISTORY_WRITE_FAILED'
  )
    return { failure_kind: 'db_write_failed', failed_stage: 'history_finalize' };
  return { failure_kind: 'unknown', failed_stage: 'upstream' };
}

export function generationFailureFields(error: unknown, signal?: AbortSignal) {
  const fields = classifyGenerationFailure(error, signal);
  const outcome =
    fields.failure_kind === 'user_stop'
      ? 'cancelled'
      : ['first_token_timeout', 'dependency_timeout'].includes(fields.failure_kind)
        ? 'timed_out'
        : 'failed';
  return { ...fields, outcome };
}

export function deliveryFailureFields(error: unknown) {
  const cause = error instanceof Error ? error.cause : error;
  const conflict = cause && typeof cause === 'object' && 'code' in cause && cause.code === 'PT409';
  return {
    failed_stage: 'delivery_select',
    failure_kind: conflict ? 'delivery_conflict' : 'db_write_failed',
    delivery_conflict_reason: 'unknown',
  };
}
