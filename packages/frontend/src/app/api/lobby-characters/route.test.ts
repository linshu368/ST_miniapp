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

    const response = await GET();

    expect(dynamic).toBe('force-dynamic');
    expect(revalidate).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/characters'),
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
  });
});
