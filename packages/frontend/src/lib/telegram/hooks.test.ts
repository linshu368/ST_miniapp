import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openExternalUrl, openPaymentUrl } from './hooks';

const openLink = vi.fn();
const isAvailable = vi.fn(() => true);

vi.mock('@telegram-apps/sdk-react', () => ({
  backButton: {
    isMounted: () => false,
    mount: vi.fn(),
    show: vi.fn(),
    onClick: vi.fn(),
    hide: vi.fn(),
  },
  hapticFeedback: {},
  isTMA: () => true,
  openLink: Object.assign((url: string) => openLink(url), { isAvailable: () => isAvailable() }),
}));

/** 刻意不挂 window.Telegram：本项目从不引入 telegram-web-app.js，
 *  任何依赖那个全局的实现在真机上都是死分支。 */
function stubWindow() {
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { assign } });
  return { assign };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAvailable.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openExternalUrl', () => {
  it('never relies on the telegram-web-app.js global', () => {
    const { assign } = stubWindow();

    openExternalUrl('https://pay.example/checkout');

    expect(openLink).toHaveBeenCalledWith('https://pay.example/checkout');
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to browser navigation when the SDK bridge is unavailable', () => {
    isAvailable.mockReturnValue(false);
    const { assign } = stubWindow();

    openExternalUrl('https://pay.example/checkout');

    expect(openLink).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://pay.example/checkout');
  });

  it('falls back to browser navigation when the bridge throws', () => {
    isAvailable.mockImplementation(() => {
      throw new Error('not initialized');
    });
    const { assign } = stubWindow();

    openExternalUrl('https://pay.example/checkout');

    expect(assign).toHaveBeenCalledWith('https://pay.example/checkout');
  });
});

describe('openPaymentUrl', () => {
  it('hands the HTTPS cashier page to Telegram instead of navigating in place', () => {
    const { assign } = stubWindow();

    openPaymentUrl('https://pay.example/checkout');

    expect(openLink).toHaveBeenCalledWith('https://pay.example/checkout');
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates directly for a WeChat scheme', () => {
    const { assign } = stubWindow();

    openPaymentUrl('weixin://dl/business/?ticket=test');

    expect(assign).toHaveBeenCalledWith('weixin://dl/business/?ticket=test');
    expect(openLink).not.toHaveBeenCalled();
  });
});
