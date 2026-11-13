import { randomUUID } from 'node:crypto';
import { currentContext } from './context.js';
import { safeName } from './events.js';

export interface AlertLog {
  event_id: string;
  event: string;
  operation: string;
  level: number;
  error_code?: string;
  outcome?: string;
  http_status?: number;
  duration_ms?: number;
}

let consumer: ((event: AlertLog) => void) | undefined;

export function subscribeLogAlerts(next: (event: AlertLog) => void): () => void {
  if (consumer) throw new Error('Log alert consumer already registered');
  consumer = next;
  return () => {
    if (consumer === next) consumer = undefined;
  };
}

/** No config, network, queue or matching work occurs while the channel is disabled. */
export function publishAlertLog(record: Record<string, unknown>, level: number): void {
  if (!consumer || typeof record.event !== 'string') return;
  if (record.event.startsWith('observability.')) return;
  try {
    const code = record.error_code ?? record.errorCode ?? record.code ?? record.errorClass;
    const event: AlertLog = {
      event_id:
        typeof record.event_id === 'string' && /^[a-f0-9-]{36}$/.test(record.event_id)
          ? record.event_id
          : randomUUID(),
      event: safeName(record.event),
      operation: safeName(record.operation ?? record.module ?? 'legacy'),
      level,
      ...(typeof code === 'string' ? { error_code: safeName(code) } : {}),
      ...(typeof record.outcome === 'string' ? { outcome: safeName(record.outcome) } : {}),
      ...(typeof record.http_status === 'number' ? { http_status: record.http_status } : {}),
      ...(typeof record.duration_ms === 'number' ? { duration_ms: record.duration_ms } : {}),
    };
    // The notification points to the same physical Railway log, including legacy events.
    record.event_id = event.event_id;
    Object.assign(record, currentContext());
    consumer(event);
  } catch {
    // Optional alert projection must not interfere with the log or business operation.
  }
}
