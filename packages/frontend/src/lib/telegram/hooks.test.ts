import { afterEach, describe, expect, it, vi } from 'vitest';

import { openPaymentUrl } from './hooks';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubTelegramWindow() {
  const assign = vi.fn();
  const openLink = vi.fn();
  vi.stubGlobal('window', {
    location: { assign, origin: 'https://app.example' },
    Telegram: { WebApp: { openLink } },
  });
  return { assign, openLink };
}

function launchedScheme(openLink: ReturnType<typeof vi.fn>) {
  const url = new URL(String(openLink.mock.calls[0]?.[0]));
  return {
    url,
    scheme: url.searchParams.get('scheme'),
    fallback: url.searchParams.get('fallback'),
  };
}

describe('openPaymentUrl', () => {
  // WebView 分发不了 App scheme，必须经由 openLink 打开的浏览器去唤起
  it('routes a WeChat scheme through the browser launch page', () => {
    const { assign, openLink } = stubTelegramWindow();

    openPaymentUrl('weixin://dl/business/?ticket=test');

    const { url, scheme } = launchedScheme(openLink);
    expect(url.origin + url.pathname).toBe('https://app.example/pay/launch.html');
    expect(scheme).toBe('weixin://dl/business/?ticket=test');
    expect(assign).not.toHaveBeenCalled();
  });

  it('routes an Alipay scheme through the browser launch page', () => {
    const { assign, openLink } = stubTelegramWindow();

    const target = 'alipays://platformapi/startapp?appId=20000067&url=http%3A%2F%2Fpay.example%2Fq';
    openPaymentUrl(target);

    const { url, scheme } = launchedScheme(openLink);
    expect(url.origin + url.pathname).toBe('https://app.example/pay/launch.html');
    expect(scheme).toBe(target);
    expect(assign).not.toHaveBeenCalled();
  });

  it('carries the cashier page as fallback for when the app is missing', () => {
    const { openLink } = stubTelegramWindow();

    openPaymentUrl('alipays://platformapi/startapp?appId=20000067', 'https://pay.example/checkout');

    expect(launchedScheme(openLink).fallback).toBe('https://pay.example/checkout');
  });

  it('uses Telegram openLink for an HTTPS payment page', () => {
    const assign = vi.fn();
    const openLink = vi.fn();
    vi.stubGlobal('window', {
      location: { assign },
      Telegram: { WebApp: { openLink } },
    });

    openPaymentUrl('https://pay.example/checkout');

    expect(openLink).toHaveBeenCalledWith('https://pay.example/checkout', {
      try_instant_view: false,
    });
    expect(assign).not.toHaveBeenCalled();
  });
});
