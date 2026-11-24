import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ init: vi.fn(), isTMA: vi.fn(() => true) }));
const sendSentryLog = vi.hoisted(() => vi.fn());
vi.mock('@telegram-apps/sdk-react', () => ({ ...sdk, miniApp: { ready: vi.fn() } }));
vi.mock('@/lib/sentry/client', () => ({ sendSentryLog }));
import { initTelegramSdk } from './init';
import { recordTelegramInitState, telegramInitState } from '@/lib/sentry/diagnostic-state';

beforeEach(() => {
  vi.clearAllMocks();
  sdk.isTMA.mockReturnValue(true);
  sdk.init.mockReset();
  recordTelegramInitState('not_started');
  vi.stubGlobal('window', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('SDK initialization ownership', () => {
  it('records success once and never initializes twice', () => {
    initTelegramSdk();
    initTelegramSdk();
    expect(telegramInitState()).toBe('initialized');
    expect(sdk.init).toHaveBeenCalledOnce();
  });
  it('keeps a partial failure visible without unsafe re-entry or private error output', async () => {
    sdk.init.mockImplementation(() => {
      throw new Error('private launch parameters');
    });
    initTelegramSdk();
    initTelegramSdk();
    expect(telegramInitState()).toBe('failed');
    expect(sdk.init).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(sendSentryLog).toHaveBeenCalledOnce());
    expect(sendSentryLog).toHaveBeenCalledWith('warn', 'telegram.sdk_init_failed', {
      stage: 'sdk_init',
    });
    expect(JSON.stringify(sendSentryLog.mock.calls)).not.toContain('private');
  });
  it('skips ordinary browsers and performs no SSR initialization', () => {
    sdk.isTMA.mockReturnValue(false);
    initTelegramSdk();
    expect(telegramInitState()).toBe('skipped');
    recordTelegramInitState('not_started');
    vi.stubGlobal('window', undefined);
    initTelegramSdk();
    expect(telegramInitState()).toBe('not_started');
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('distinguishes a failed environment probe from SDK initialization', async () => {
    sdk.isTMA.mockImplementationOnce(() => {
      throw new Error('private launch data');
    });
    initTelegramSdk();
    expect(telegramInitState()).toBe('failed');
    expect(sdk.init).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(sendSentryLog).toHaveBeenCalledWith('warn', 'telegram.sdk_init_failed', {
        stage: 'environment_probe',
      })
    );
  });
});
