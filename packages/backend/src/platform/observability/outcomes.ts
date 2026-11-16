import type { Outcome } from './events.js';

/** Existing subsystem vocabulary remains public; this projection is for diagnostics only. */
const OUTCOMES: Readonly<Record<string, Outcome>> = {
  success: 'succeeded',
  completed: 'succeeded',
  ok: 'succeeded',
  succeeded: 'succeeded',
  insufficient_balance: 'rejected',
  vip_required: 'rejected',
  filtered: 'rejected',
  rejected: 'rejected',
  error: 'failed',
  failed: 'failed',
  upstream_error: 'failed',
  timeout: 'timed_out',
  first_token_timeout: 'timed_out',
  first_token_deadline: 'timed_out',
  user_cancelled: 'cancelled',
  cancelled: 'cancelled',
  race_lost: 'cancelled',
  stream_interrupted: 'interrupted',
  interrupted: 'interrupted',
  length: 'degraded',
  partial: 'degraded',
  degraded: 'degraded',
  skipped: 'skipped',
  budget_skipped: 'skipped',
  first_token_observed: 'pending',
  pending: 'pending',
  streaming: 'pending',
};

export function observationOutcome(value: string): Outcome {
  return OUTCOMES[value] ?? 'unknown';
}
