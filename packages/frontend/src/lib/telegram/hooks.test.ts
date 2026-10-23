import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  openExternalUrl,
  openPaymentUrl,
  openTelegramCommunity,
  requestTelegramFileDownload,
} from './hooks';

const openLink = vi.fn();
const isAvailable = vi.fn(() => true);
const openTelegramLink = vi.fn();
const telegramLinkAvailable = vi.fn(() => true);
const downloadFile = vi.fn<(url: string, fileName: string) => Promise<void>>();
const downloadAvailable = vi.fn(() => true);

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
