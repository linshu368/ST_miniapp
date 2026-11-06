import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, dynamic, revalidate } from './route';

describe('lobby characters route', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();

    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
