import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ createSignedUrl: vi.fn(), testTarget: vi.fn() }));
vi.mock('../../platform/runtime-config.js', () => ({
  isTestImageTransformTarget: state.testTarget,
}));
vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (...args: unknown[]) => state.createSignedUrl(bucket, ...args),
      }),
    },
  }),
}));

const { signPrivateVideoPath, signSharedVideoPath, signSharedWorkImagePath } =
  await import('./storage.js');

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

  it('coalesces concurrent signing for the same video path', async () => {
    const path = `media-plaza-video/attempts/33333333-3333-4333-8333-${crypto.randomUUID().slice(-12)}/video.mp4`;
    let release: (() => void) | undefined;
    state.createSignedUrl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              data: { signedUrl: `https://storage.example.test/${path}` },
              error: null,
            });
        })
    );

    const requests = Array.from({ length: 8 }, () => signSharedVideoPath(path));
    await vi.waitFor(() => expect(state.createSignedUrl).toHaveBeenCalledTimes(1));
    release?.();

    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 8 }, () => `https://storage.example.test/${path}`)
    );
    expect(state.createSignedUrl).toHaveBeenCalledTimes(1);
  });
});

describe('private plaza image samples', () => {
  const size = { width: 720, quality: 72 };
  const ordinary = 'image-plaza/imports/civitai/42.png';
  const sample = 'image-plaza/imports/civitai/130594518.png';
  it('uses the existing private original signature and key only on TEST', async () => {
    state.createSignedUrl.mockReset();
    state.createSignedUrl.mockImplementation(async (_bucket, _path, _ttl, options) => ({
      data: { signedUrl: options.transform ? 'signed-variant' : 'signed-original' },
      error: null,
    }));
    state.testTarget.mockReturnValue(true);
    expect(await signSharedWorkImagePath(ordinary, size)).toBe('signed-original');
    expect(await signSharedWorkImagePath(ordinary)).toBe('signed-original');
    expect(state.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(state.createSignedUrl).toHaveBeenCalledWith('image-plaza', ordinary, 86400, {});
    expect(await signSharedWorkImagePath(sample, size)).toBe('signed-variant');
    state.testTarget.mockReturnValue(false);
    expect(await signSharedWorkImagePath(ordinary, size)).toBe('signed-variant');
    expect(state.createSignedUrl).toHaveBeenCalledWith('image-plaza', ordinary, 86400, {
      transform: size,
    });
  });
});
