import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/telegram/auth', () => ({
  getRawInitData: () => null,
  INIT_DATA_HEADER: 'X-Telegram-Init-Data',
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/sentry/client', () => ({
  sendSentryLog: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: vi.fn(),
  metrics: { distribution: vi.fn(), count: vi.fn() },
  captureMessage: vi.fn(),
  withScope: vi.fn(),
}));

import { RequestTimeoutError } from '@/lib/perf/request-timing';

import {
  ApiClientError,
  apiClient,
  isRetryableGetTransportError,
  toApiClientError,
} from './client';
import { __resetRequestConcurrencyForTests } from './request-concurrency';

describe('isRetryableGetTransportError', () => {
  it('retries GET timeout and network TypeError only', () => {
    expect(isRetryableGetTransportError(new RequestTimeoutError('/api/x', 1000), 'GET')).toBe(true);
    expect(isRetryableGetTransportError(new TypeError('Failed to fetch'), 'GET')).toBe(true);
    expect(
      isRetryableGetTransportError(new ApiClientError('请求超时', 0, 'client_timeout'), 'GET')
    ).toBe(true);
  });

  it('does not retry POST, HTTP errors, or caller abort', () => {
    const signal = AbortSignal.abort();
    expect(isRetryableGetTransportError(new RequestTimeoutError('/api/x', 1000), 'POST')).toBe(
      false
    );
    expect(isRetryableGetTransportError(toApiClientError(500, null), 'GET')).toBe(false);
    expect(
      isRetryableGetTransportError(new RequestTimeoutError('/api/x', 1000), 'GET', signal)
    ).toBe(false);
  });
});

describe('apiClient GET transport retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetRequestConcurrencyForTests(3);
  });
  afterEach(() => {
    __resetRequestConcurrencyForTests(3);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries once after RequestTimeoutError then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('timeout', 'AbortError'))
            );
          })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { ok: true } }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const pending = apiClient<{ ok: boolean }>('/api/characters', { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry POST timeouts', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'AbortError'))
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = apiClient('/api/wallet/checkin', { method: 'POST', timeoutMs: 500 });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'client_timeout',
    });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
