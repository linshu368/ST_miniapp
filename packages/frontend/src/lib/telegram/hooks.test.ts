import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  openExternalUrl,
  openPaymentUrl,
  openTelegramCommunity,
  requestTelegramFileDownload,
  suspendTelegramVerticalSwipes,
} from './hooks';

const openLink = vi.fn();
const isAvailable = vi.fn(() => true);
const openTelegramLink = vi.fn();
const telegramLinkAvailable = vi.fn(() => true);
const downloadFile = vi.fn<(url: string, fileName: string) => Promise<void>>();
const downloadAvailable = vi.fn(() => true);
const swipeAvailable = vi.fn(() => true);
const swipeMounted = vi.fn(() => false);
const swipeEnabled = vi.fn(() => true);
const swipeMount = vi.fn();
const swipeUnmount = vi.fn();
const disableSwipe = vi.fn();
const enableSwipe = vi.fn();

vi.mock('@telegram-apps/sdk-react', () => ({
  backButton: {
    isMounted: () => false,
    mount: vi.fn(),
    show: vi.fn(),
    onClick: vi.fn(),
    hide: vi.fn(),
  },
  downloadFile: Object.assign((url: string, fileName: string) => downloadFile(url, fileName), {
    isAvailable: () => downloadAvailable(),
  }),
  hapticFeedback: {},
  swipeBehavior: {
    mount: Object.assign(() => swipeMount(), { isAvailable: () => swipeAvailable() }),
    isMounted: () => swipeMounted(),
    isVerticalEnabled: () => swipeEnabled(),
    disableVertical: () => disableSwipe(),
    enableVertical: () => enableSwipe(),
    unmount: () => swipeUnmount(),
  },
  isTMA: () => true,
  openLink: Object.assign((url: string) => openLink(url), { isAvailable: () => isAvailable() }),
  openTelegramLink: Object.assign((url: string) => openTelegramLink(url), {
    isAvailable: () => telegramLinkAvailable(),
  }),
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
  telegramLinkAvailable.mockReturnValue(true);
  downloadAvailable.mockReturnValue(true);
  downloadFile.mockResolvedValue();
  swipeAvailable.mockReturnValue(true);
  swipeMounted.mockReturnValue(false);
  swipeEnabled.mockReturnValue(true);
});

describe('suspendTelegramVerticalSwipes', () => {
  it('disables native minimizing while watching and restores it on exit', () => {
    stubWindow();
    // 真实 SDK mount 会先把竖滑状态设为 false。
    swipeMount.mockImplementationOnce(() => swipeEnabled.mockReturnValue(false));
    const restore = suspendTelegramVerticalSwipes();
    expect(swipeMount).toHaveBeenCalledOnce();
    expect(disableSwipe).toHaveBeenCalledOnce();
    expect(enableSwipe).not.toHaveBeenCalled();
    restore();
    expect(enableSwipe).toHaveBeenCalledOnce();
    expect(swipeUnmount).toHaveBeenCalledOnce();
  });

  it('preserves a pre-existing disabled state and mounted owner', () => {
    stubWindow();
    swipeMounted.mockReturnValue(true);
    swipeEnabled.mockReturnValue(false);
    const restore = suspendTelegramVerticalSwipes();
    expect(disableSwipe).toHaveBeenCalledOnce();
    restore();
    expect(swipeMount).not.toHaveBeenCalled();
    expect(enableSwipe).not.toHaveBeenCalled();
    expect(swipeUnmount).not.toHaveBeenCalled();
  });

  it('does nothing for unsupported clients or server rendering', () => {
    stubWindow();
    swipeAvailable.mockReturnValue(false);
    suspendTelegramVerticalSwipes()();
    vi.stubGlobal('window', undefined);
    suspendTelegramVerticalSwipes()();
    expect(disableSwipe).not.toHaveBeenCalled();
    expect(swipeMount).not.toHaveBeenCalled();
  });

  it('does not break navigation if restoring the native bridge fails', () => {
    stubWindow();
    const restore = suspendTelegramVerticalSwipes();
    enableSwipe.mockImplementationOnce(() => {
      throw new Error('client disconnected');
    });
    expect(restore).not.toThrow();
    expect(swipeUnmount).toHaveBeenCalledOnce();
  });
});

describe('openTelegramCommunity', () => {
  it('uses Telegram native link bridge synchronously', () => {
    stubWindow();
    expect(openTelegramCommunity('https://t.me/MijingAI_Official')).toBe(true);
    expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/MijingAI_Official');
  });

  it('returns false without navigating when the native bridge is unavailable', () => {
    telegramLinkAvailable.mockReturnValue(false);
    const { assign } = stubWindow();
    expect(openTelegramCommunity('https://t.me/MijingAI_Official')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
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

describe('requestTelegramFileDownload', () => {
  const url = 'https://images.example.test/generated.webp';
  const fileName = 'mijing-image-preview.webp';

  it('returns false without a browser and does not invoke the native bridge', async () => {
    vi.stubGlobal('window', undefined);
    await expect(requestTelegramFileDownload(url, fileName)).resolves.toBe(false);
    expect(downloadAvailable).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('returns false without navigating when the download bridge is unavailable', async () => {
    const { assign } = stubWindow();
    downloadAvailable.mockReturnValue(false);
    await expect(requestTelegramFileDownload(url, fileName)).resolves.toBe(false);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });

  it('waits for the SDK callback before confirming that the save request was accepted', async () => {
    const { assign } = stubWindow();
    let accept!: () => void;
    downloadFile.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        accept = resolve;
      })
    );
    const settled = vi.fn();
    const request = requestTelegramFileDownload(url, fileName);
    void request.then(settled);
    expect(downloadFile).toHaveBeenCalledExactlyOnceWith(url, fileName);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    accept();
    await expect(request).resolves.toBe(true);
    expect(settled).toHaveBeenCalledWith(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it('preserves native rejection so the caller can show its retry and original-image fallback', async () => {
    const { assign } = stubWindow();
    const error = new Error('preview download rejected');
    downloadFile.mockRejectedValueOnce(error);
    await expect(requestTelegramFileDownload(url, fileName)).rejects.toBe(error);
    expect(downloadFile).toHaveBeenCalledExactlyOnceWith(url, fileName);
    expect(assign).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });
});
