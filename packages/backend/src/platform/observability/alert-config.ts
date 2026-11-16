import { closeSync, openSync, readSync } from 'node:fs';
import { parseLogAlertFile, parseLogAlertPolicy, type LogAlertPolicy } from './alert-policy.js';

export const LOG_ALERT_RULES_URL = new URL('./alert-rules.json', import.meta.url);
const MAX_BYTES = 16_384;

/** Project assembly only. The SDK entry never imports this filesystem adapter. */
export function loadLogAlertPolicy(
  enabled?: string,
  file: URL = LOG_ALERT_RULES_URL
): LogAlertPolicy {
  const state = parseLogAlertPolicy(enabled);
  if (!state.enabled) return state;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, 'r');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_BYTES) throw new Error('LOG_ALERT_CONFIG_INVALID');
    const config = parseLogAlertFile(buffer.subarray(0, length).toString('utf8'));
    for (const rule of config.rules) {
      for (const value of Object.values(rule)) if (Array.isArray(value)) Object.freeze(value);
      Object.freeze(rule);
    }
    return Object.freeze({ enabled: true, rules: Object.freeze(config.rules) });
  } catch {
    // File/JSON errors can include paths or rule contents; bootstrap may bypass Pino serialization.
    throw new Error('LOG_ALERT_CONFIG_INVALID');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        throw new Error('LOG_ALERT_CONFIG_INVALID');
      }
    }
  }
}
