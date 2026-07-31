import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openLink = vi.fn() as ReturnType<typeof vi.fn> & { isAvailable: () => boolean };
openLink.isAvailable = () => true;

vi.mock('@telegram-apps/sdk-react', () => ({
  openLink,
  isTMA: () => true,
  backButton: {
    isMounted: () => false,
    mount: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    onClick: vi.fn(),
  },
  hapticFeedback: {
    impactOccurred: Object.assign(vi.fn(), { isAvailable: () => true }),
    selectionChanged: Object.assign(vi.fn(), { isAvailable: () => true }),
    notificationOccurred: Object.assign(vi.fn(), { isAvailable: () => true }),
  },
  useSignal: vi.fn(),
  useLaunchParams: vi.fn(),
  useRawInitData: vi.fn(),
  useRawLaunchParams: vi.fn(),
}));

const { openPaymentUrl } = await import('./hooks');

beforeEach(() => {
  openLink.isAvailable = () => true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubWindow() {
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { assign, origin: 'https://app.example' } });
  return { assign };
}

function launched() {
  const url = new URL(String(openLink.mock.calls[0]?.[0]));
  return {
    page: url.origin + url.pathname,
    scheme: url.searchParams.get('scheme'),
    fallback: url.searchParams.get('fallback'),
  };
}

describe('openPaymentUrl', () => {
  // Mini App 的 WebView 分发不了 App scheme，必须让 Telegram 用浏览器打开中转页
  it('routes a WeChat scheme through the browser launch page', () => {
    const { assign } = stubWindow();

    openPaymentUrl('weixin://dl/business/?ticket=test');

    expect(launched().page).toBe('https://app.example/pay/launch.html');
    expect(launched().scheme).toBe('weixin://dl/business/?ticket=test');
    expect(assign).not.toHaveBeenCalled();
  });

  it('routes an Alipay scheme through the browser launch page', () => {
    const { assign } = stubWindow();
    const target = 'alipays://platformapi/startapp?appId=20000067&url=http%3A%2F%2Fpay.example%2Fq';

    openPaymentUrl(target);

    expect(launched().page).toBe('https://app.example/pay/launch.html');
    expect(launched().scheme).toBe(target);
    expect(assign).not.toHaveBeenCalled();
  });

  it('carries the cashier page as fallback for when the app is missing', () => {
    stubWindow();

    openPaymentUrl('alipays://platformapi/startapp?appId=20000067', 'https://pay.example/checkout');

    expect(launched().fallback).toBe('https://pay.example/checkout');
  });

  it('hands an HTTPS payment page straight to Telegram', () => {
    const { assign } = stubWindow();

    openPaymentUrl('https://pay.example/checkout');

    expect(openLink).toHaveBeenCalledWith('https://pay.example/checkout');
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to plain navigation outside Telegram', () => {
    const { assign } = stubWindow();
    openLink.isAvailable = () => false;

    openPaymentUrl('https://pay.example/checkout');

    expect(openLink).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://pay.example/checkout');
  });
});
