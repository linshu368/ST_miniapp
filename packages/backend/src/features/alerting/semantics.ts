import type { AlertEvaluation } from '@miniapp/shared';

export type AlertTransition = 'firing' | 'escalated' | 'recovered';
export type IncidentRow = {
  id: bigint;
  state: 'open' | 'recovered';
  severity: AlertEvaluation['severity'];
  last_window_ended_at: Date;
  last_observed_at: Date;
  latest_evaluation_id: string;
};

const severityRank: Record<AlertEvaluation['severity'], number> = { P2: 1, P1: 2, P0: 3 };

export function isNewer(row: IncidentRow, evaluation: AlertEvaluation): boolean {
  const windowEnded = new Date(evaluation.window_ended_at).getTime();
  const observed = new Date(evaluation.observed_at).getTime();
  const previousWindow = row.last_window_ended_at.getTime();
  const previousObserved = row.last_observed_at.getTime();
  return (
    windowEnded > previousWindow || (windowEnded === previousWindow && observed > previousObserved)
  );
}

export function transitionFor(
  row: IncidentRow,
  evaluation: AlertEvaluation
): AlertTransition | null {
  if (evaluation.state === 'healthy') return row.state === 'open' ? 'recovered' : null;
  if (row.state === 'recovered') return 'firing';
  return severityRank[evaluation.severity] > severityRank[row.severity] ? 'escalated' : null;
}

export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const computed = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 60_000);
  return Math.max(computed, retryAfterMs ?? 0);
}
