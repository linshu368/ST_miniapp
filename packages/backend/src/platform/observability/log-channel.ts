import { randomUUID } from 'node:crypto';
import { contextLogFields } from './context.js';
import { safeErrorCode, safeName } from './events.js';

export interface AlertLog {
  event_id: string;
  event: string;
  operation: string;
  level: number;
  error_code?: string;
  public_error_code?: string;
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
    const code =
      record.error_code ??
      record.errorCode ??
      record.code ??
      record.errorClass ??
      safeErrorCode(record.err ?? record.error);
    const status = record.http_status ?? record.statusCode ?? record.status;
    const duration = record.duration_ms ?? record.durationMs;
    const event: AlertLog = {
      event_id:
        typeof record.event_id === 'string' && /^[a-f0-9-]{36}$/.test(record.event_id)
          ? record.event_id
          : randomUUID(),
      event: safeName(record.event),
      operation: safeName(record.operation ?? record.module ?? 'legacy'),
      level,
      ...(typeof code === 'string' ? { error_code: safeName(code) } : {}),
      ...(typeof record.public_error_code === 'string'
        ? { public_error_code: safeName(record.public_error_code) }
        : {}),
      ...(typeof record.outcome === 'string' ? { outcome: safeName(record.outcome) } : {}),
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? { http_status: status }
        : {}),
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
        ? { duration_ms: duration }
        : {}),
    };
    // The notification points to the same physical Railway log, including legacy events.
    record.event_id = event.event_id;
    Object.assign(record, contextLogFields());
    consumer(event);
  } catch {
    // Optional alert projection must not interfere with the log or business operation.
  }
}
