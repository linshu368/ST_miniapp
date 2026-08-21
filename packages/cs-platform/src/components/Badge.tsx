import type { CsSessionStatus, CsWaitingState } from '@miniapp/shared';
import { SESSION_STATUS_META, WAITING_STATE_META } from '../constants';

export function SessionBadge({ status }: { status: CsSessionStatus }) {
  const meta = SESSION_STATUS_META[status] ?? { label: status, tone: 'neutral' as const };
  return <span className={`badge badge-${meta.tone}`}>{meta.label}</span>;
}

export function WaitingBadge({ state }: { state: CsWaitingState }) {
  const meta = WAITING_STATE_META[state];
  if (!meta) return null;
  return <span className={`badge badge-${meta.tone}`}>{meta.label}</span>;
}
