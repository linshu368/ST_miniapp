import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { distribution, count, captureMessage, withScope } = vi.hoisted(() => ({
  distribution: vi.fn(),
  count: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setLevel: vi.fn(), setFingerprint: vi.fn(), setTags: vi.fn(), setContext: vi.fn() })
  ),
}));

vi.mock('@sentry/nextjs', () => ({
  metrics: { distribution, count },
  captureMessage,
  withScope,
}));
vi.mock('@telegram-apps/sdk-react', () => ({ retrieveLaunchParams: () => ({}) }));

import { snapshotInflight } from './inflight';
import {
  __resetRequestConcurrencyForTests,
  getRequestConcurrencyStats,
  withRequestSlot,
} from '../api/request-concurrency';
import {
  outcomeForStatus,
  RequestTimeoutError,
  SLOW_REQUEST_MS,
  timedFetch,
} from './request-timing';

describe('outcomeForStatus', () => {
  it('maps status to outcome', () => {
    expect(outcomeForStatus(200)).toBe('ok');
    expect(outcomeForStatus(402)).toBe('http_4xx');
    expect(outcomeForStatus(503)).toBe('http_5xx');
  });
});

describe('timedFetch', () => {
  beforeEach(() => {
    __resetRequestConcurrencyForTests();
    distribution.mockClear();
    count.mockClear();
    captureMessage.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records duration for a fast ok request without raising an event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const res = await timedFetch(
      'https://api.test/api/wallet/balance',
      {},
      { requestId: 'r1' },
      async (response) => response
    );
    expect(res.status).toBe(200);
    expect(distribution).toHaveBeenCalledWith(
      'api.request.duration',
      expect.any(Number),
      expect.objectContaining({
        attributes: expect.objectContaining({ route: '/api/wallet/balance', outcome: 'ok' }),
      })
    );
    expect(distribution).toHaveBeenCalledWith(
      'api.headers.duration',
      expect.any(Number),
      expect.objectContaining({
        attributes: expect.objectContaining({ route: '/api/wallet/balance', outcome: 'ok' }),
      })
    );
    expect(captureMessage).not.toHaveBeenCalled();
    expect(snapshotInflight()).toEqual([]);
  });

  it('raises a slow_request event when the response takes too long', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response('{}', { status: 200 })), SLOW_REQUEST_MS + 500)
          )
      )
    );
    const pending = timedFetch(
      'https://api.test/api/characters',
      {},
      { requestId: 'r2' },
      async (response) => response
    );
    await vi.advanceTimersByTimeAsync(SLOW_REQUEST_MS + 600);
    await pending;
    expect(captureMessage).toHaveBeenCalledWith('slow_request');
  });

  it('aborts with RequestTimeoutError and reports outcome=timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('x', 'AbortError'))
            );
          })
      )
    );
    const pending = timedFetch(
      'https://api.test/api/characters',
      {},
      { requestId: 'r3', timeoutMs: 1000 },
      async (response) => response
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
    expect(distribution).toHaveBeenCalledWith(
      'api.request.duration',
      expect.any(Number),
      expect.objectContaining({ attributes: expect.objectContaining({ outcome: 'timeout' }) })
    );
    expect(snapshotInflight()).toEqual([]);
  });

  it('does not report a caller-initiated abort as a failure', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('x', 'AbortError'))
            );
          })
      )
    );
    const pending = timedFetch(
      'https://api.test/api/characters',
      { signal: controller.signal },
      { requestId: 'r4' },
      async (response) => response
    );
    const assertion = expect(pending).rejects.toBeDefined();
    controller.abort();
    await assertion;
    expect(distribution).not.toHaveBeenCalled();
  });

  it('keeps the request working when metrics reporting throws', async () => {
    distribution.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(
      timedFetch(
        'https://api.test/api/wallet/balance',
        {},
        { requestId: 'r5' },
        async (response) => response
      )
    ).resolves.toBeInstanceOf(Response);
    expect(count).toHaveBeenCalledWith(
      'perf.instrument_error',
      1,
      expect.objectContaining({
        attributes: { side: 'frontend', stage: 'request_headers_timing' },
      })
    );
  });

  it('keeps timeout and inflight active until the response body consumer settles', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal ?? undefined;
        return Promise.resolve(new Response('{}', { status: 200 }));
      })
    );
    const pending = timedFetch(
      'https://api.test/api/characters',
      {},
      { requestId: 'body-timeout', timeoutMs: 1000 },
      async (_response) =>
        new Promise<never>((_resolve, reject) =>
          requestSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('timeout', 'AbortError')),
            { once: true }
          )
        )
    );
    expect(snapshotInflight()).toHaveLength(1);
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
    expect(distribution).toHaveBeenCalledWith(
      'api.request.duration',
      expect.any(Number),
      expect.objectContaining({ attributes: expect.objectContaining({ outcome: 'timeout' }) })
    );
    expect(snapshotInflight()).toEqual([]);
  });

  it('does not label a successful header with an invalid response body as ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('broken', { status: 200 })));
    await expect(
      timedFetch('https://api.test/api/characters', {}, { requestId: 'invalid-body' }, async () => {
        throw new Error('invalid envelope');
      })
    ).rejects.toThrow('invalid envelope');
    expect(distribution).toHaveBeenCalledWith(
      'api.request.duration',
      expect.any(Number),
      expect.objectContaining({
        attributes: expect.objectContaining({ outcome: 'invalid_response' }),
      })
    );
  });

  it('includes slot queue time in the deadline and never dispatches expired work', async () => {
    __resetRequestConcurrencyForTests(1);
    let release: () => void = () => {};
    const occupied = withRequestSlot(
      'critical',
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await Promise.resolve();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const pending = timedFetch(
      '/api/characters',
      {},
      { requestId: 'queued', timeoutMs: 1000, priority: 'critical' },
      async () => 'done'
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(fetch).not.toHaveBeenCalled();
    expect(getRequestConcurrencyStats().waiting).toBe(0);
    release();
    await occupied;
    expect(snapshotInflight()).toEqual([]);
  });

  it('releases a slot when an uncooperative body reader never settles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    const pending = timedFetch(
      '/api/characters',
      {},
      { requestId: 'stuck-body', timeoutMs: 1000, priority: 'critical' },
      () => new Promise<never>(() => {})
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(getRequestConcurrencyStats().inFlight).toBe(0);
    expect(snapshotInflight()).toEqual([]);
  });
});
