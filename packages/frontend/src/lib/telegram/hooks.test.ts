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

/** 刻意不挂 window.Telegram：本项目不引入官方 telegram-web-app.js，真机上也没有这个全局。 */
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

  // 回归护栏。这个修复曾被一次发布回滚带回坏版本：坏版本判断 window.Telegram.WebApp.openLink，
  // 而那个全局来自本项目从不引入的 telegram-web-app.js，于是恒为假、一律退化成本页导航，
  // 微信拉不起来。当时的测试自己 stub 出了该全局，所以 CI 全绿、回归隐形。
  // 这里断言在没有该全局时依然走 SDK 桥——任何重新依赖它的实现都会在这里失败。
  it('never relies on the telegram-web-app.js global', () => {
    const { assign } = stubWindow();

    expect('Telegram' in window).toBe(false);

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
