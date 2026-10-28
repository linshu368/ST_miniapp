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
import { __resetRequestConcurrencyForTests, withRequestSlot } from './request-concurrency';
import type { ApiAttemptTiming } from './client';

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
  it('retains the first GET failure when a single-attempt experiment opts out', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      apiClient('/api/drama-cdn-experiment/play', { transportRetry: false })
    ).rejects.toThrow('Failed to fetch');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('transportRetry');
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    __resetRequestConcurrencyForTests(3);
  });
  afterEach(() => {
    __resetRequestConcurrencyForTests(3);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('includes queue wait, response headers and body parsing without leaking observation options into fetch', async () => {
    __resetRequestConcurrencyForTests(1);
    let release!: () => void;
    const blocker = withRequestSlot(
      'normal',
      undefined,
      () =>
        new Promise<void>((done) => {
          release = done;
        })
    );
    await Promise.resolve();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        expect(init).not.toHaveProperty('onAttempt');
        const response = new Response('{}', { status: 200 });
        vi.spyOn(response, 'json').mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ success: true, data: { ok: true } }), 1500)
            )
        );
        return new Promise<Response>((resolve) => setTimeout(() => resolve(response), 500));
      })
    );
    const attempts: ApiAttemptTiming[] = [];
    const pending = apiClient('/api/dramas', { onAttempt: (attempt) => attempts.push(attempt) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    release();
    await blocker;
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      queuedAt: 0,
      dispatchedAt: 1000,
      headersAt: 1500,
      endedAt: 3000,
      outcome: 'ok',
      status: 200,
    });
  });

  it('retains each transport retry request ID and keeps backoff outside attempt duration', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('timeout', 'AbortError'))
            )
          )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);
    const attempts: ApiAttemptTiming[] = [];
    const pending = apiClient('/api/dramas', {
      timeoutMs: 20_000,
      onAttempt: (attempt) => attempts.push(attempt),
    });
    await vi.advanceTimersByTimeAsync(20_200);
    await pending;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ queuedAt: 0, endedAt: 20_000, outcome: 'timeout' });
    expect(attempts[1]).toMatchObject({ queuedAt: 20_200, outcome: 'ok' });
    expect(attempts[0]?.requestId).not.toBe(attempts[1]?.requestId);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toBeInstanceOf(Headers);
    expect(
      new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get('X-Request-Id')
    ).toBe(attempts[1]?.requestId);
  });

  it('observation exceptions cannot fail or retry a successful request', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
        )
    );
    await expect(
      apiClient('/api/dramas', {
        onAttempt: () => {
          throw new Error('observer failed');
        },
      })
    ).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('records cancellation while queued without pretending the request reached the server', async () => {
    __resetRequestConcurrencyForTests(1);
    let release!: () => void;
    const blocker = withRequestSlot(
      'normal',
      undefined,
      () =>
        new Promise<void>((done) => {
          release = done;
        })
    );
    await Promise.resolve();
    vi.stubGlobal('fetch', vi.fn());
    const controller = new AbortController();
    const attempts: ApiAttemptTiming[] = [];
    const pending = apiClient('/api/dramas', {
      signal: controller.signal,
      onAttempt: (attempt) => attempts.push(attempt),
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await rejected;
    expect(attempts[0]).toMatchObject({ endedAt: 500, outcome: 'aborted' });
    expect(attempts[0]?.dispatchedAt).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    release();
    await blocker;
  });
});
