import { z } from 'zod';
import type { AlertLog } from './log-channel.js';

const name = z.string().regex(/^[a-zA-Z0-9_.:/-]{1,120}$/);
const names = z.array(name).min(1).max(32);
export const logAlertRuleSchema = z
  .object({
    id: name,
    severity: z.enum(['P0', 'P1', 'P2']).default('P1'),
    min_level: z.enum(['info', 'warn', 'error', 'fatal']).default('error'),
    events: names.optional(),
    operations: names.optional(),
    error_codes: names.optional(),
    outcomes: names.optional(),
    min_http_status: z.number().int().min(100).max(599).optional(),
    min_duration_ms: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type LogAlertRule = z.infer<typeof logAlertRuleSchema>;
export interface LogAlertPolicy {
  enabled: boolean;
  rules: LogAlertRule[];
}

export function parseLogAlertPolicy(enabled?: string, rules?: string): LogAlertPolicy {
  if (enabled === undefined || enabled === '' || enabled === 'false')
    return { enabled: false, rules: [] };
  if (enabled !== 'true') throw new Error('LOG_ALERTING_ENABLED must be true or false');
  try {
    if (rules && rules.length > 16_384) throw new Error();
    const parsed = z
      .array(logAlertRuleSchema)
      .min(1)
      .max(32)
      .parse(rules ? JSON.parse(rules) : [{ id: 'runtime-errors' }]);
    if (new Set(parsed.map((rule) => rule.id)).size !== parsed.length) throw new Error();
    return { enabled: true, rules: parsed };
  } catch {
    // Never include raw deployment configuration in validation errors.
    throw new Error('LOG_ALERT_RULES must contain 1-32 valid rules with unique IDs');
  }
}

const LEVEL = { info: 30, warn: 40, error: 50, fatal: 60 } as const;
export function matchesLogRule(rule: LogAlertRule, event: AlertLog): boolean {
  return (
    event.level >= LEVEL[rule.min_level] &&
    (!rule.events || rule.events.includes(event.event)) &&
    (!rule.operations || rule.operations.includes(event.operation)) &&
    (!rule.error_codes ||
      (event.error_code !== undefined && rule.error_codes.includes(event.error_code))) &&
    (!rule.outcomes || (event.outcome !== undefined && rule.outcomes.includes(event.outcome))) &&
    (rule.min_http_status === undefined ||
      (event.http_status !== undefined && event.http_status >= rule.min_http_status)) &&
    (rule.min_duration_ms === undefined ||
      (event.duration_ms !== undefined && event.duration_ms >= rule.min_duration_ms))
  );
}
