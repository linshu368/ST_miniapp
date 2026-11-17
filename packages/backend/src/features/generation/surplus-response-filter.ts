import {
  SURPLUS_EXCLUDED_KEYS,
  safeSurplusIdentifier,
  safeSurplusIdentity,
  surplusMoney,
  surplusRecord,
  type SurplusJson,
  type SurplusObject,
  type SurplusRule,
} from './surplus-response-schema.js';

export type SurplusIssue = 'unknown' | 'invalid' | 'excluded' | 'over_limit';
export interface SurplusDiagnostic {
  kind: SurplusIssue;
  path: string;
  type: string;
}
export type ReportSurplusIssue = (kind: SurplusIssue, path: string, value: unknown) => void;

export function safeSurplusPath(path: string): string {
  return path
    .split('.')
    .map((part) => {
      if (part === '[]') return part;
      return /^[a-z][a-z0-9_\-]{0,47}$/i.test(part) && !/^(?:sk[-_]|inf[-_]|eyJ)/i.test(part)
        ? part
        : '[dynamic]';
    })
    .join('.')
    .slice(0, 256);
}

function scalar(value: unknown, rule: SurplusRule): value is SurplusJson {
  if (typeof rule !== 'string') return false;
  switch (rule) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'duration':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
      );
    case 'finite':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= Number.MAX_SAFE_INTEGER
      );
    case 'code':
      return (
        (typeof value === 'number' && Number.isSafeInteger(value)) ||
        safeSurplusIdentifier(value, 128)
      );
    case 'money':
      return surplusMoney(value) !== null;
    case 'identifier':
      return safeSurplusIdentifier(value);
    case 'identity':
      return safeSurplusIdentity(value);
    case 'label':
      return safeSurplusIdentifier(value, 128);
  }
}

/** Every nested leaf is checked; accepting an object is never permission to archive its values. */
export function filterSurplusValue(
  value: unknown,
  rule: SurplusRule,
  report: ReportSurplusIssue,
  path: string,
  depth = 0
): SurplusJson | undefined {
  if (depth > 8) {
    report('over_limit', path, value);
    return undefined;
  }
  if (value === null) return null;
  if (typeof rule === 'string') {
    if (scalar(value, rule)) return value;
    report('invalid', path, value);
    return undefined;
  }
  if ('values' in rule) {
    if (typeof value === 'string' && rule.values.includes(value)) return value;
    report('invalid', path, value);
    return undefined;
  }
  if ('items' in rule) return filterArray(value, rule.items, report, path, depth);
  const source = surplusRecord(value);
  if (!source) {
    report('invalid', path, value);
    return undefined;
  }
  const result: SurplusObject = {};
  for (const [key, child] of Object.entries(source)) {
    const childPath = `${path}.${key}`;
    const childRule = rule.fields[key];
    if (!Object.hasOwn(rule.fields, key) || childRule === undefined) {
      report(SURPLUS_EXCLUDED_KEYS.has(key) ? 'excluded' : 'unknown', childPath, child);
      continue;
    }
    const filtered = filterSurplusValue(child, childRule, report, childPath, depth + 1);
    if (filtered !== undefined) result[key] = filtered;
  }
  return result;
}

function filterArray(
  value: unknown,
  rule: SurplusRule,
  report: ReportSurplusIssue,
  path: string,
  depth: number
): SurplusJson[] | undefined {
  if (!Array.isArray(value)) {
    report('invalid', path, value);
    return undefined;
  }
  if (value.length > 128) report('over_limit', path, value);
  const result: SurplusJson[] = [];
  for (const item of value.slice(0, 128)) {
    const filtered = filterSurplusValue(item, rule, report, `${path}.[]`, depth + 1);
    if (filtered !== undefined) result.push(filtered);
  }
  return result;
}

export const SURPLUS_HEADER_NAMES = new Set([
  'x-request-id',
  'x-si-request-id',
  'x-generation-id',
  'x-si-served-by',
  'x-si-provider-family',
  'x-si-marketplace-status',
  'x-si-routing-decision-ms',
  'x-si-marketplace-attempts',
  'x-si-attempts',
  'x-si-buyer-cost-micro',
  'x-si-adapted-params',
  'x-si-truncated',
  'x-si-secret-masking',
  'x-si-secrets-masked',
  'x-si-secrets-withheld',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
]);

export function validSurplusHeader(name: string, value: string): boolean {
  if (name.includes('request-id') || name === 'x-generation-id') return safeSurplusIdentity(value);
  if (name === 'x-si-served-by')
    return ['marketplace', 'preferred_key', 'fallback_key'].includes(value);
  if (name === 'x-si-provider-family' || name === 'x-si-marketplace-status')
    return safeSurplusIdentifier(value, 128);
  if (name === 'x-si-routing-decision-ms')
    return (
      value.length <= 30 &&
      /^[0-9]+(?:\.[0-9]+)?$/.test(value) &&
      Number(value) <= Number.MAX_SAFE_INTEGER
    );
  if (name === 'x-si-secret-masking') return ['applied', 'not_applied'].includes(value);
  if (name === 'x-si-truncated') return value === '0' || value === '1';
  if (name === 'x-si-attempts')
    return (
      value.length <= 8192 &&
      /^(?:[a-z0-9_.-]+:[a-zA-Z0-9_-]+:(?:unavailable|rate_limited|not_found|upstream_error|request_rejected|timeout|error)(?:,\s*)?)*(?:\+\d+ more)?$/.test(
        value
      )
    );
  if (name === 'x-si-adapted-params')
    return value.length <= 2048 && /^(?:[a-z][a-z0-9_.]*(?:,\s*)?)*$/.test(value);
  if (name === 'retry-after' || name === 'x-ratelimit-reset')
    return (
      value.length <= 64 &&
      (/^[0-9]+(?:\.[0-9]+)?$/.test(value) || Number.isFinite(Date.parse(value)))
    );
  return surplusMoney(value) !== null;
}
