import type { FastifyBaseLogger } from 'fastify';

/** One business terminal supplements HTTP/DB terminals without copying receipt or identity. */
export function receiptDiagnostics(log: FastifyBaseLogger) {
  const start = performance.now();
  const durations: Partial<Record<'identity_ms' | 'rpc_ms', number>> = {};
  let failedStage: 'identity' | 'first_token' | undefined;
  let completed = false;
  const emit = (recorded?: boolean) => {
    if (completed) return;
    completed = true;
    try {
      log[recorded ? 'info' : 'warn']({
        event: 'conversation.first_token_receipt',
        operation: 'conversation.first_token_receipt',
        outcome: recorded === undefined ? 'unknown' : recorded ? 'succeeded' : 'rejected',
        outcome_known: recorded !== undefined,
        stage: recorded === undefined ? 'unconfirmed' : recorded ? 'recorded' : 'not_recorded',
        failed_stage: failedStage,
        ...durations,
        duration_ms: Math.round(performance.now() - start),
      });
    } catch {
      // The existing HTTP terminal retains the original error and response.
    }
  };
  return {
    async measure<T>(stage: 'identity' | 'first_token', run: () => Promise<T>): Promise<T> {
      const started = performance.now();
      try {
        return await run();
      } catch (err) {
        failedStage = stage;
        throw err;
      } finally {
        durations[stage === 'identity' ? 'identity_ms' : 'rpc_ms'] = Math.round(
          performance.now() - started
        );
      }
    },
    success: (recorded: boolean) => emit(recorded),
    failure: () => emit(),
  };
}
