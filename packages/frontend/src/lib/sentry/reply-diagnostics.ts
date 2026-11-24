import { sendSentryLog } from './client';

const REASONS = new Set(['WORKER_UNAVAILABLE', 'WORKER_START_TIMEOUT', 'WORKER_ERROR', 'TIMEOUT']);
const emittedAt = new Map<string, number>();
let emitted = 0;

/** Committed original-text fallback, not evidence that sending or billing failed. */
export function reportReplyFallback(reason: string): void {
  if (!REASONS.has(reason) || emitted >= 8) return;
  const now = Date.now();
  const previous = emittedAt.get(reason);
  if (previous !== undefined && now - previous < 60_000) return;
  emittedAt.set(reason, now);
  emitted += 1;
  try {
    sendSentryLog('warn', 'reply.postprocess_fallback', {
      reason,
      display_state: 'original_committed',
    });
  } catch {
    // Telemetry output cannot replace readable text with an error boundary.
  }
}
