import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adoptPayUrlQueryIntoStorage,
  clearPaymentOpen,
  clearPaymentOpenIfTerminal,
  hasPaymentOpenUrl,
  isAllowedPaymentOpenUrl,
  PAYMENT_OPEN_TTL_MS,
  paymentOrderPagePath,
  persistPaymentOpen,
  readPaymentOpenMeta,
  readPaymentOpenUrl,
} from './open-storage';
import { setReplaySessionStorageForTests } from './session-storage';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

beforeEach(() => {
  setReplaySessionStorageForTests(memoryStorage());
});

afterEach(() => {
  setReplaySessionStorageForTests(undefined);
});

describe('payment open storage', () => {
  it('stores reopen URL by order id and never puts it in the waiting path', () => {
    expect(
      persistPaymentOpen({
        orderId: 'TG_1',
        payUrl: 'https://pay.example/checkout',
        returnTo: '/chat/c1',
        replayContextId: '11111111-1111-4111-8111-111111111111',
        now: 1_000,
      })
    ).toBeUndefined();
    expect(readPaymentOpenUrl('TG_1', 1_000)).toBe('https://pay.example/checkout');
    expect(readPaymentOpenMeta('TG_1', 1_000)).toEqual({
      returnTo: '/chat/c1',
      replayContextId: '11111111-1111-4111-8111-111111111111',
      createdAt: 1_000,
    });
    expect(paymentOrderPagePath('TG_1', { paymentStarted: true, returnTo: '/chat/c1' })).toBe(
      '/profile/recharge/TG_1?payment_started=1&returnTo=%2Fchat%2Fc1'
    );
    expect(
      paymentOrderPagePath('TG_1', { paymentStarted: true, returnTo: '/chat/c1' })
    ).not.toContain('pay_url');
  });

  it('rejects invalid URLs and missing storage without throwing', () => {
    expect(isAllowedPaymentOpenUrl('javascript:alert(1)')).toBe(false);
    expect(
      persistPaymentOpen({
        orderId: 'TG_1',
        payUrl: 'not-a-url',
        returnTo: null,
        replayContextId: null,
      })
    ).toBe('invalid_url');
    expect(hasPaymentOpenUrl('TG_1')).toBe(false);

    setReplaySessionStorageForTests(null);
    expect(
      persistPaymentOpen({
        orderId: 'TG_1',
        payUrl: 'https://pay.example/checkout',
        returnTo: null,
        replayContextId: null,
      })
    ).toBe('storage_unavailable');
  });

  it('expires by TTL and clears on terminal order status', () => {
    persistPaymentOpen({
      orderId: 'TG_1',
      payUrl: 'https://pay.example/checkout',
      returnTo: '/chat/c1',
      replayContextId: null,
      now: 1_000,
    });
    expect(readPaymentOpenUrl('TG_1', 1_000 + PAYMENT_OPEN_TTL_MS + 1)).toBeNull();

    persistPaymentOpen({
      orderId: 'TG_1',
      payUrl: 'https://pay.example/checkout',
      returnTo: null,
      replayContextId: null,
      now: 5_000,
    });
    clearPaymentOpenIfTerminal('TG_1', 'pending');
    expect(hasPaymentOpenUrl('TG_1', 5_000)).toBe(true);
    clearPaymentOpenIfTerminal('TG_1', 'completed');
    expect(hasPaymentOpenUrl('TG_1', 5_000)).toBe(false);
    persistPaymentOpen({
      orderId: 'TG_1',
      payUrl: 'https://pay.example/checkout',
      returnTo: null,
      replayContextId: null,
      now: 6_000,
    });
    clearPaymentOpen('TG_1');
    expect(hasPaymentOpenUrl('TG_1', 6_000)).toBe(false);
  });

  it('moves a leaked pay_url query into storage and strips it from the location', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        href: 'https://miniapp.local/profile/recharge/TG_1?pay_url=https://pay.example/x&payment_started=1',
      },
      history: { state: null, replaceState },
    });
    adoptPayUrlQueryIntoStorage('TG_1', 'https://pay.example/x', '/chat/c1', null);
    expect(readPaymentOpenUrl('TG_1')).toBe('https://pay.example/x');
    expect(replaceState).toHaveBeenCalled();
    const nextUrl = replaceState.mock.calls[0]?.[2] as string;
    expect(nextUrl).not.toContain('pay_url');
    expect(nextUrl).toContain('payment_started=1');
    vi.unstubAllGlobals();
  });
});
