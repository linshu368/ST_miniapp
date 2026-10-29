import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineering = vi.hoisted(() => ({ measurement: vi.fn(), event: vi.fn() }));
vi.mock('@/lib/perf/grafana', () => ({
  isEngineeringTelemetryEnabled: () => true,
  recordEngineeringMeasurement: engineering.measurement,
  recordEngineeringEvent: engineering.event,
}));

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
import { reportConversationFirstToken } from './conversations';
import { __resetFirstTokenReportsForTests } from './first-token-reports';
import type { ReportFirstTokenRequest } from '@miniapp/shared';
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

describe('first-token report compatibility and bounded retries', () => {
  const body: ReportFirstTokenRequest = {
    request_id: '11111111-1111-4111-8111-111111111111',
    assistant_message_id: '22222222-2222-4222-8222-222222222222',
    revision: 0,
    measurement_method: 'client_committed_v4',
    outcome: 'observed',
    first_token_visible_ms: 2000,
    request_dispatched_ms: 20,
    first_token_received_ms: 1950,
    wait_finished_ms: 2000,
    backgrounded: false,
    reason: null,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    __resetFirstTokenReportsForTests();
    __resetRequestConcurrencyForTests(3);
    // Chrome 90/92 have AbortController but no AbortSignal.timeout static method.
    vi.stubGlobal('AbortSignal', { timeout: undefined });
  });
  afterEach(() => {
    __resetFirstTokenReportsForTests();
    __resetRequestConcurrencyForTests(3);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const response = (recorded: boolean) =>
    new Response(JSON.stringify({ success: true, data: { recorded } }), { status: 200 });

  it('reports on WebViews without AbortSignal.timeout and cleans its deadline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(true));
    vi.stubGlobal('fetch', fetchMock);
    const pending = reportConversationFirstToken('fixture-session', body);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(body),
      keepalive: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries an unrecorded receipt with the same identity then stops on confirmation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(true));
    vi.stubGlobal('fetch', fetchMock);
    const pending = reportConversationFirstToken('fixture-session', body);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[1].body)).toEqual([
      JSON.stringify(body),
      JSON.stringify(body),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds each transport attempt at three seconds and never exceeds three attempts', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'AbortError'))
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = reportConversationFirstToken('fixture-session', body);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(301);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(7000);
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every((call) => call[1].signal?.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps queue wait within each deadline and never sends expired queued attempts', async () => {
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
    const fetchMock = vi.fn().mockResolvedValue(response(true));
    vi.stubGlobal('fetch', fetchMock);
    const pending = reportConversationFirstToken('fixture-session', body);
    await vi.advanceTimersByTimeAsync(10300);
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    release();
    await blocker;
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(apiClient('/api/fixture')).resolves.toEqual({ recorded: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while reading the receipt response body', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        const stalled = response(true);
        vi.spyOn(stalled, 'json').mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('timeout', 'AbortError'))
              );
            })
        );
        return Promise.resolve(stalled);
      })
      .mockResolvedValueOnce(response(true));
    vi.stubGlobal('fetch', fetchMock);
    const pending = reportConversationFirstToken('fixture-session', body);
    await vi.advanceTimersByTimeAsync(3300);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('apiClient GET transport retry', () => {
  it('retains the first GET failure when a single-attempt experiment opts out', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      apiClient('/api/transport-retry-fixture', { transportRetry: false })
    ).rejects.toThrow('Failed to fetch');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('transportRetry');
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    __resetRequestConcurrencyForTests(3);
    engineering.measurement.mockClear();
    engineering.event.mockClear();
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
    expect(engineering.measurement).toHaveBeenCalledWith(
      'api.total',
      3000,
      expect.objectContaining({ attempts: 1, outcome: 'ok' })
    );
    expect(engineering.measurement).toHaveBeenCalledWith(
      'api.body',
      1500,
      expect.objectContaining({ attempt: 1 })
    );
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
    expect(engineering.measurement).toHaveBeenCalledWith(
      'api.total',
      20_200,
      expect.objectContaining({ attempts: 2, outcome: 'ok' })
    );
    expect(engineering.event).toHaveBeenCalledTimes(1);
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
