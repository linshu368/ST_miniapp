import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isAllowedPostHogHost, readPostHogBrowserEnv, resolvePostHogConfig } from './config';

describe('resolvePostHogConfig', () => {
  it('no-ops when key or host is missing', () => {
    expect(resolvePostHogConfig({ key: undefined, host: 'https://us.i.posthog.com' })).toEqual({
      ok: false,
      failureCode: 'missing_config',
    });
    expect(resolvePostHogConfig({ key: 'phc_test', host: undefined })).toEqual({
      ok: false,
      failureCode: 'missing_config',
    });
  });

  it('rejects non-https or credentialed hosts', () => {
    expect(isAllowedPostHogHost('http://us.i.posthog.com')).toBe(false);
    expect(isAllowedPostHogHost('https://user:pass@us.i.posthog.com')).toBe(false);
    expect(isAllowedPostHogHost('https://us.i.posthog.com/extra')).toBe(false);
    expect(isAllowedPostHogHost('not-a-url')).toBe(false);
  });

  it('accepts an https PostHog host without path or query', () => {
    expect(resolvePostHogConfig({ key: 'phc_test', host: 'https://us.i.posthog.com' })).toEqual({
      ok: true,
      key: 'phc_test',
      host: 'https://us.i.posthog.com',
    });
  });

  it('reads public config from static process.env members so Next can inline them', () => {
    const previousKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const previousHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    process.env.NEXT_PUBLIC_POSTHOG_KEY = ' phc_inline_test ';
    process.env.NEXT_PUBLIC_POSTHOG_HOST = ' https://us.i.posthog.com ';
    try {
      expect(readPostHogBrowserEnv()).toEqual({
        key: 'phc_inline_test',
        host: 'https://us.i.posthog.com',
      });
    } finally {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = previousKey;
      process.env.NEXT_PUBLIC_POSTHOG_HOST = previousHost;
    }
  });

  it('keeps static process.env.NEXT_PUBLIC_POSTHOG_* member access in source', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config.ts'), 'utf8');
    expect(source).toContain('process.env.NEXT_PUBLIC_POSTHOG_KEY');
    expect(source).toContain('process.env.NEXT_PUBLIC_POSTHOG_HOST');
  });
});
