import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, dynamic, revalidate } from './route';

describe('lobby characters route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bypasses upstream and edge caches', async () => {
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
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
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
});
