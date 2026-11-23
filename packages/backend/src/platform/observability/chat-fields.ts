/** Fixed, browser-safe diagnostics. No arbitrary error text, object IDs or message contents. */
export interface ChatDiagnosticFields {
  read_path?: string;
  history_page_kind?: string;
  failed_stage?: string;
  failure_kind?: string;
  cancel_source?: string;
  delivery_conflict_reason?: string;
  sample_rate?: number;
}

const ENUMS: Record<string, ReadonlySet<string>> = {
  read_path: new Set(['parallel', 'aggregate', 'legacy']),
  history_page_kind: new Set(['entry', 'older', 'poll', 'refresh', 'unknown']),
  failed_stage: new Set([
    'identity',
    'owner',
    'settings',
    'recover',
    'opening',
    'page',
    'map',
    'first_token',
    'delivery_select',
    'history_finalize',
    'billing',
    'upstream',
    'unknown',
  ]),
  failure_kind: new Set([
    'not_found',
    'permission_denied',
    'client_disconnected',
    'user_stop',
    'first_token_timeout',
    'dependency_timeout',
    'dependency_failed',
    'network_failure',
    'db_read_failed',
    'db_write_failed',
    'delivery_conflict',
    'invalid_result',
    'unknown',
  ]),
  cancel_source: new Set([
    'client_close',
    'user_stop',
    'deadline',
    'dependency',
    'turn_terminal',
    'unknown',
  ]),
  delivery_conflict_reason: new Set([
    'already_terminal',
    'winner_conflict',
    'identity_mismatch',
    'unknown',
  ]),
};

export function chatDiagnosticFields(record: object): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && ENUMS[key]?.has(value)) result[key] = value;
    if (key === 'sample_rate' && typeof value === 'number' && value > 0 && value <= 1)
      result[key] = value;
  }
  return result;
}
