import { mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLogAlertPolicy } from './alert-config.js';
import { matchesLogRule, parseLogAlertRules } from './alert-policy.js';
import type { AlertLog } from './alert-types.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync) };
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'logging-config-'));
  vi.clearAllMocks();
});
afterEach(() => {
  for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
  rmdirSync(directory);
  vi.unstubAllEnvs();
});
function config(content: unknown): URL {
  const file = join(directory, 'rules.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return pathToFileURL(file);
}
const event: AlertLog = {
  event_id: 'fixture',
  event: 'operation.terminal',
  operation: 'http.request',
  level: 50,
  module: 'http',
  business_module: 'payment',
  http_status: 503,
  upstream_status: 429,
};

describe('file-only log alert rules', () => {
  it.each([undefined, '', 'false'])('does no I/O when the global switch is %s', (enabled) => {
    expect(loadLogAlertPolicy(enabled, pathToFileURL(join(directory, 'missing.json')))).toEqual({
      enabled: false,
      rules: [],
    });
    expect(openSync).not.toHaveBeenCalled();
  });

  it('reads the fixed module-relative file and ignores the retired environment rule value', () => {
    vi.stubEnv('LOG_ALERT_RULES', 'invalid retired config');
    const policy = loadLogAlertPolicy('true');
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(Object.isFrozen(policy.rules[0])).toBe(true);
    expect(policy.rules.filter((rule) => rule.enabled).map((rule) => rule.id)).toEqual([
      'runtime-errors',
    ]);
    expect(matchesLogRule(policy.rules.at(-1)!, event)).toBe(true);
  });

  it.each([
    'not-json',
    { version: 2, rules: [{ id: 'x' }] },
    { version: 1, rules: [] },
    { version: 1, rules: [{ id: 'x' }, { id: 'x' }] },
    { version: 1, rules: [{ id: 'x', http_statuses: ['503'] }] },
    { version: 1, rules: [{ id: 'x', upstream_statuses: [600] }] },
    { version: 1, rules: [{ id: 'x', unknown: 'fixture private value' }] },
    { version: 1, rules: Array.from({ length: 33 }, (_, i) => ({ id: `rule-${i}` })) },
    ' '.repeat(16_385),
  ])('fails with a stable error for invalid configuration %#', (input) => {
    expect(() => loadLogAlertPolicy('true', config(input))).toThrow(/^LOG_ALERT_CONFIG_INVALID$/);
  });

  it('fails closed for missing enabled files and invalid switches', () => {
    expect(() =>
      loadLogAlertPolicy('true', pathToFileURL(join(directory, 'missing.json')))
    ).toThrow(/^LOG_ALERT_CONFIG_INVALID$/);
    expect(() => loadLogAlertPolicy('TRUE')).toThrow('must be true or false');
  });

  it('distinguishes technical/business modules and HTTP/upstream status and combines conditions', () => {
    const rules = parseLogAlertRules([
      {
        id: 'http',
        modules: ['http'],
        business_modules: ['payment'],
        http_statuses: [503],
        upstream_statuses: [429],
      },
      { id: 'off', enabled: false },
    ]);
    expect(matchesLogRule(rules[0]!, event)).toBe(true);
    for (const change of [
      { module: 'payment' },
      { business_module: 'chat' },
      { http_status: 429 },
      { upstream_status: 503 },
      { business_module: undefined },
      { upstream_status: undefined },
    ])
      expect(matchesLogRule(rules[0]!, { ...event, ...change })).toBe(false);
    expect(matchesLogRule(rules[1]!, event)).toBe(false);
    const threshold = parseLogAlertRules([
      { id: 'both', min_http_status: 500, http_statuses: [429] },
    ])[0]!;
    expect(matchesLogRule(threshold, { ...event, http_status: 429 })).toBe(false);
  });
});
