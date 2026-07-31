import { describe, expect, it } from 'vitest';

import { stripSensitiveTelegramLaunchParams } from './launch-url';

describe('stripSensitiveTelegramLaunchParams', () => {
  it('removes Telegram init data from the launch fragment', () => {
    const url = 'https://example.test/#tgWebAppData=user%3D1%26hash%3Dsigned&tgWebAppVersion=8.0';

    expect(stripSensitiveTelegramLaunchParams(url)).toBe(
      'https://example.test/#tgWebAppVersion=8.0'
    );
  });

  it('removes sensitive aliases from query and fragment parameters', () => {
    const url =
      'https://example.test/path?foo=1&rawInitData=secret#x-init-data=signed&section=chat';

    expect(stripSensitiveTelegramLaunchParams(url)).toBe(
      'https://example.test/path?foo=1#section=chat'
    );
  });

  it('preserves URLs without sensitive Telegram launch parameters', () => {
    const url = 'https://example.test/path?foo=1#ordinary-anchor';

    expect(stripSensitiveTelegramLaunchParams(url)).toBe(url);
  });
});
