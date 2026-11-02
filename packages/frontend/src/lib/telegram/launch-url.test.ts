import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getTelegramStartParam,
  rememberInviteStartParam,
  INVITE_BIND_PENDING_KEY,
  stripSensitiveTelegramLaunchParams,
} from './launch-url';

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

describe('captured launch context', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('prefers initData and captures the value before sanitizing', () => {
    const raw = 'start_param=inv_Abcd1234&hash=fictional';
    const url = `https://example.test/?tgWebAppData=${encodeURIComponent(raw)}&startapp=channel`;
    const captured = getTelegramStartParam(raw, new URL(url).search);
    expect(captured).toBe('inv_Abcd1234');
    expect(stripSensitiveTelegramLaunchParams(url)).toBe('https://example.test/?startapp=channel');
    expect(captured).toBe('inv_Abcd1234');
  });
  it.each(['startapp', 'start_param', 'tgWebAppStartParam'])(
    'supports %s and preserves payment return identifiers',
    (alias) => {
      expect(getTelegramStartParam(undefined, `?${alias}=payment_return_order-123`)).toBe(
        'payment_return_order-123'
      );
      expect(getTelegramStartParam('start_param=%20', `?${alias}=%20channel%20`)).toBe('channel');
    }
  );
  it('persists valid invites before reporting and ignores invalid values', () => {
    const setItem = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem });
    rememberInviteStartParam('inv_Abcd1234');
    expect(setItem).toHaveBeenCalledExactlyOnceWith(INVITE_BIND_PENDING_KEY, 'Abcd1234');
    for (const value of ['inv_short', 'inv_1234567!', 'channel', 'payment_return_order-123'])
      rememberInviteStartParam(value);
    expect(setItem).toHaveBeenCalledTimes(1);
  });
  it('does not block entry when storage is denied', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => rememberInviteStartParam('inv_Abcd1234')).not.toThrow();
  });
});
