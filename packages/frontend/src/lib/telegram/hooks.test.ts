import { afterEach, describe, expect, it, vi } from 'vitest';

import { openPaymentUrl } from './hooks';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openPaymentUrl', () => {
  it('navigates directly for a WeChat scheme', () => {
    const assign = vi.fn();
    const openLink = vi.fn();
    vi.stubGlobal('window', {
      location: { assign },
      Telegram: { WebApp: { openLink } },
    });

    openPaymentUrl('weixin://dl/business/?ticket=test');

    expect(assign).toHaveBeenCalledWith('weixin://dl/business/?ticket=test');
    expect(openLink).not.toHaveBeenCalled();
  });

  it('navigates directly for an Alipay scheme', () => {
    const assign = vi.fn();
    const openLink = vi.fn();
    vi.stubGlobal('window', {
      location: { assign },
      Telegram: { WebApp: { openLink } },
    });

    const scheme =
      'alipays://platformapi/startapp?saId=10000007&qrcode=http%3A%2F%2Fpay.example%2Fq';
    openPaymentUrl(scheme);

    expect(assign).toHaveBeenCalledWith(scheme);
    expect(openLink).not.toHaveBeenCalled();
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
