import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ createSignedUrl: vi.fn() }));
vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (path: string, ttl: number) => state.createSignedUrl(bucket, path, ttl),
      }),
    },
  }),
}));

const { signPrivateVideoPath, signSharedVideoPath } = await import('./storage.js');

describe('video signed URL cache', () => {
  beforeEach(() => {
    state.createSignedUrl.mockReset();
    state.createSignedUrl.mockImplementation(async (bucket: string, path: string, ttl: number) => ({
      data: { signedUrl: `https://storage.example.test/${bucket}/${path}?ttl=${ttl}` },
      error: null,
    }));
  });

  it('reuses a byte-identical 24h URL for public video and poster paths', async () => {
    const path = `media-plaza-video/attempts/11111111-1111-4111-8111-${crypto.randomUUID().slice(-12)}/video.mp4`;
    const first = await signSharedVideoPath(path);
    const second = await signSharedVideoPath(path);
    expect(second).toBe(first);
    expect(state.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(state.createSignedUrl).toHaveBeenCalledWith('media-plaza-video', path, 86_400);
  });

  it('keeps private and shared TTLs in separate cache entries', async () => {
    const path = `media-plaza-video/attempts/22222222-2222-4222-8222-${crypto.randomUUID().slice(-12)}/poster.jpg`;
    await signPrivateVideoPath(path);
    await signSharedVideoPath(path);
    expect(state.createSignedUrl).toHaveBeenCalledTimes(2);
  });
});
