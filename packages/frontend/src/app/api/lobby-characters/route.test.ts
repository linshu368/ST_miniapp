import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, dynamic, revalidate } from './route';

describe('lobby characters route', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards a bounded request ID, returns backend correlation and emits one safe terminal', async () => {
    const requestId = 'fixture-proxy-request';
    const traceId = 'a'.repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('private fixture response', {
        headers: { 'X-Request-Id': requestId, 'X-Trace-Id': traceId },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(
      new Request('http://localhost/api/lobby-characters?private=fixture', {
        headers: { 'X-Request-Id': requestId, Authorization: 'fixture credential' },
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { 'X-Request-Id': requestId },
      })
    );
    expect(response.headers.get('X-Request-Id')).toBe(requestId);
    expect(response.headers.get('X-Trace-Id')).toBe(traceId);
    expect(console.info).toHaveBeenCalledOnce();
    const record = JSON.parse(vi.mocked(console.info).mock.calls[0]![0]);
    expect(record).toMatchObject({
      event: 'lobby.proxy.terminal',
      request_id: requestId,
      trace_id: traceId,
      http_status: 200,
      outcome: 'succeeded',
    });
    expect(JSON.stringify(record)).not.toMatch(/private|credential|Authorization/);
  });

  it('replaces invalid IDs and rejects untrusted backend correlation headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        headers: { 'X-Request-Id': 'unsafe/value', 'X-Trace-Id': 'unsafe-trace' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(
      new Request('http://localhost/api/lobby-characters', {
        headers: { 'X-Request-Id': 'x'.repeat(129) },
      })
    );
    expect(response.headers.get('X-Request-Id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.get('X-Trace-Id')).toBeNull();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('unsafe');
  });

  it('keeps backend correlation on body-read failure and tolerates a failed log output', async () => {
    const traceId = 'b'.repeat(32);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('private fixture body'));
            },
          }),
          { headers: { 'X-Trace-Id': traceId } }
        )
      )
    );
    vi.mocked(console.error).mockImplementationOnce(() => {
      throw new Error('fixture output failure');
    });
    const response = await GET(new Request('http://localhost/api/lobby-characters'));
    expect(response.status).toBe(502);
    expect(response.headers.get('X-Trace-Id')).toBe(traceId);
    expect(console.error).toHaveBeenCalledOnce();
    const record = JSON.parse(vi.mocked(console.error).mock.calls[0]![0]);
    expect(record).toMatchObject({
      trace_id: traceId,
      outcome: 'failed',
      public_error_code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(JSON.stringify(record)).not.toContain('private fixture');
  });

  it('keeps the default recommended route uncached', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"success":true,"data":{"characters":[]}}', {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new Request('http://localhost/api/lobby-characters'));

    expect(dynamic).toBe('force-dynamic');
    expect(revalidate).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/characters'),
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(response.headers.get('Server-Timing')).toMatch(/^backend;dur=\d+(?:\.\d)$/);
  });

  it('exposes only a successful latest catalogue to the shared 60 second cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"success":true,"data":{"characters":[]}}', { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response('{"success":false,"error":{"code":"FAILED","message":"failed"}}', {
          status: 503,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const latest = await GET(new Request('http://localhost/api/lobby-characters?sort=latest'));
    const failed = await GET(new Request('http://localhost/api/lobby-characters?sort=latest'));

    expect(latest.headers.get('Cache-Control')).toBe(
      'public, max-age=60, s-maxage=60, stale-while-revalidate=60'
    );
    expect(failed.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
  });

  it('只透传白名单内的排序值', async () => {
    // 每次调用都要新的 Response：body 只能被读取一次。
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response('{"success":true,"data":{"characters":[]}}', {
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await GET(new Request('http://localhost/api/lobby-characters?sort=latest'));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('sort=latest'),
      expect.anything()
    );

    await GET(new Request('http://localhost/api/lobby-characters?sort=../../evil'));
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('sort=recommended'),
      expect.anything()
    );
  });

  it('forwards a bounded head and preserves requested order without accepting duplicate IDs', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response('{"success":true,"data":{"characters":[]}}'));
    vi.stubGlobal('fetch', fetchMock);
    const ids = ['10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001'];
    const url = 'http://localhost/api/lobby-characters?sort=recommended&limit=12';
    await GET(new Request(url));
    await GET(new Request(url + '&ids=' + ids.join(',')));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('sort=recommended&limit=12'),
      expect.anything()
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ids=' + ids.join(',')),
      expect.anything()
    );
    expect((await GET(new Request(url + '&ids=' + [ids[0], ids[0]].join(',')))).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts the upstream request when the incoming request is cancelled', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const pending = GET(
      new Request('http://localhost/api/lobby-characters', { signal: controller.signal })
    );
    await Promise.resolve();
    controller.abort();

    const response = await pending;
    expect(response.status).toBe(499);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0]![0])).toMatchObject({
      outcome: 'cancelled',
      http_status: 499,
    });
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'REQUEST_ABORTED' },
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a non-cacheable JSON failure when the upstream cannot connect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection failed')));
    const response = await GET(new Request('http://localhost/api/lobby-characters?sort=latest'));
    expect(response.status).toBe(502);
    expect(console.error).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]![0])).toMatchObject({
      outcome: 'failed',
      http_status: 502,
    });
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: '角色没加载出来，再试一次吧' },
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('distinguishes the proxy deadline from cancellation and never caches the timeout', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      )
    );
    const pending = GET(new Request('http://localhost/api/lobby-characters?sort=latest'));
    deadline.abort(new DOMException('timeout', 'TimeoutError'));
    const response = await pending;
    expect(response.status).toBe(504);
    expect(console.error).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]![0])).toMatchObject({
      outcome: 'timed_out',
      http_status: 504,
    });
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'UPSTREAM_TIMEOUT' },
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});
