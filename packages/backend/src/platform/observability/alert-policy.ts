import { z } from 'zod';
import type { AlertLog } from './alert-types.js';

const name = z.string().regex(/^[a-zA-Z0-9_.:/-]{1,120}$/);
const names = z.array(name).min(1).max(32);
export const logAlertRuleSchema = z
  .object({
    id: name,
    enabled: z.boolean().default(true),
    severity: z.enum(['P0', 'P1', 'P2']).default('P1'),
    min_level: z.enum(['info', 'warn', 'error', 'fatal']).default('error'),
    events: names.optional(),
    operations: names.optional(),
    modules: names.optional(),
    business_modules: names.optional(),
    http_statuses: z.array(z.number().int().min(100).max(599)).min(1).max(32).optional(),
    upstream_statuses: z.array(z.number().int().min(100).max(599)).min(1).max(32).optional(),
    error_codes: names.optional(),
    public_error_codes: names.optional(),
    outcomes: names.optional(),
    min_http_status: z.number().int().min(100).max(599).optional(),
    min_duration_ms: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type LogAlertRule = z.infer<typeof logAlertRuleSchema>;
export interface LogAlertPolicy {
  readonly enabled: boolean;
  readonly rules: readonly LogAlertRule[];
}

const rulesSchema = z
  .array(logAlertRuleSchema)
  .min(1)
  .max(32)
  .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length);

/** Pure SDK boundary: callers supply configuration data, never a process environment. */
export function parseLogAlertRules(input: unknown): LogAlertRule[] {
  try {
    return rulesSchema.parse(input);
  } catch {
    throw new Error('Log alert rules must contain 1-32 valid rules with unique IDs');
  }
}

export function parseLogAlertFile(content: string): { version: 1; rules: LogAlertRule[] } {
  try {
    if (Buffer.byteLength(content, 'utf8') > 16_384) throw new Error('LOG_ALERT_CONFIG_INVALID');
    return z
      .object({ version: z.literal(1), rules: rulesSchema })
      .strict()
      .parse(JSON.parse(content));
  } catch {
    // A configuration error must not echo rules, file paths or secret-bearing parser messages.
    throw new Error('LOG_ALERT_CONFIG_INVALID');
  }
}

export function parseLogAlertPolicy(enabled?: string, rules?: string): LogAlertPolicy {
  if (enabled === undefined || enabled === '' || enabled === 'false')
    return { enabled: false, rules: [] };
  if (enabled !== 'true') throw new Error('LOG_ALERTING_ENABLED must be true or false');
  try {
    if (rules && rules.length > 16_384) throw new Error();
    const parsed = parseLogAlertRules(rules ? JSON.parse(rules) : [{ id: 'runtime-errors' }]);
    return { enabled: true, rules: parsed };
  } catch {
    // Never include raw deployment configuration in validation errors.
    throw new Error('Log alert rules must contain 1-32 valid rules with unique IDs');
  }
}

const LEVEL = { info: 30, warn: 40, error: 50, fatal: 60 } as const;
export function matchesLogRule(rule: LogAlertRule, event: AlertLog): boolean {
  return (
    rule.enabled &&
    event.level >= LEVEL[rule.min_level] &&
    (!rule.events || rule.events.includes(event.event)) &&
    (!rule.operations || rule.operations.includes(event.operation)) &&
    (!rule.modules || (event.module !== undefined && rule.modules.includes(event.module))) &&
    (!rule.business_modules ||
      (event.business_module !== undefined &&
        rule.business_modules.includes(event.business_module))) &&
    (!rule.http_statuses ||
      (event.http_status !== undefined && rule.http_statuses.includes(event.http_status))) &&
    (!rule.upstream_statuses ||
      (event.upstream_status !== undefined &&
        rule.upstream_statuses.includes(event.upstream_status))) &&
    (!rule.error_codes ||
      [event.error_code, event.public_error_code].some(
        (code) => code !== undefined && rule.error_codes!.includes(code)
      )) &&
    (!rule.public_error_codes ||
      (event.public_error_code !== undefined &&
        rule.public_error_codes.includes(event.public_error_code))) &&
    (!rule.outcomes || (event.outcome !== undefined && rule.outcomes.includes(event.outcome))) &&
    (rule.min_http_status === undefined ||
      (event.http_status !== undefined && event.http_status >= rule.min_http_status)) &&
    (rule.min_duration_ms === undefined ||
      (event.duration_ms !== undefined && event.duration_ms >= rule.min_duration_ms))
  );
}
