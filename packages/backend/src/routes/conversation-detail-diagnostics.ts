import type { FastifyBaseLogger } from 'fastify';
import { ConversationReadPurposeSchema } from '@miniapp/shared';
import { ConversationRepositoryError } from '../infrastructure/repositories/conversation-errors.js';

export type DetailPhase = 'identity' | 'owner' | 'settings' | 'opening' | 'page' | 'map';

function emit(
  log: FastifyBaseLogger,
  level: 'info' | 'warn' | 'error',
  fields: Record<string, unknown>
) {
  try {
    log[level](fields);
  } catch {
    // Diagnostic output must never change the response or replace the original dependency error.
  }
}

async function waitForRead<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** One bounded read summary; HTTP/DB observers retain their independent transport terminals. */
export function detailDiagnostics(
  log: FastifyBaseLogger,
  purpose: unknown,
  older: boolean,
  signal?: AbortSignal
) {
  const startedAt = performance.now();
  const phases: Partial<Record<DetailPhase, number>> = {};
  const parsed = ConversationReadPurposeSchema.safeParse(purpose);
  const history_page_kind = older ? 'older' : parsed.success ? parsed.data : 'unknown';
  let firstFailure: { phase: DetailPhase; error: unknown } | undefined;
  let completed = false;
  const fields = () => ({
    read_path: 'parallel',
    history_page_kind,
    duration_ms: Math.round(performance.now() - startedAt),
    ...Object.fromEntries(Object.entries(phases).map(([key, ms]) => [`${key}_ms`, ms])),
  });
  return {
    async measure<T>(phase: DetailPhase, run: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        signal?.throwIfAborted();
        return await waitForRead(run(), signal);
      } catch (error) {
        firstFailure ??= { phase, error };
        throw error;
      } finally {
        phases[phase] = Math.round(performance.now() - start);
      }
    },
    success(messageCount: number, attempts: number) {
      if (completed) return;
      completed = true;
      const slow = performance.now() - startedAt >= 1_000 || attempts > 1;
      if (!slow && (history_page_kind !== 'entry' || Math.random() >= 0.1)) return;
      emit(log, slow ? 'warn' : 'info', {
        ...fields(),
        event: slow ? 'conversation.detail.slow' : 'conversation.detail.read',
        operation: 'conversation.detail.read',
        outcome: 'succeeded',
        message_count: messageCount,
        attempt: attempts,
        sample_rate: slow ? 1 : 0.1,
      });
    },
    failure(error: unknown, disconnected: boolean) {
      if (completed) return;
      completed = true;
      const expected = error instanceof ConversationRepositoryError;
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      const failed_stage =
        firstFailure && firstFailure.error === error ? firstFailure.phase : 'unknown';
      emit(log, disconnected || expected ? 'info' : timeout ? 'warn' : 'error', {
        ...fields(),
        event: disconnected ? 'conversation.detail.cancelled' : 'conversation.detail.failed',
        operation: 'conversation.detail.read',
        outcome: disconnected
          ? 'interrupted'
          : expected
            ? 'rejected'
            : timeout
              ? 'timed_out'
              : 'failed',
        failed_stage,
        failure_kind: disconnected
          ? 'client_disconnected'
          : expected
            ? 'not_found'
            : timeout
              ? 'dependency_timeout'
              : 'dependency_failed',
        ...(disconnected ? { cancel_source: 'client_close' } : { err: error }),
        ...(expected ? { public_error_code: error.code } : {}),
      });
    },
  };
}
