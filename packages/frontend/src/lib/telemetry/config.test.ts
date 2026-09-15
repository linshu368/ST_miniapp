import { describe, expect, it } from 'vitest';

import { isAllowedPostHogHost, resolvePostHogConfig } from './config';

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
});
