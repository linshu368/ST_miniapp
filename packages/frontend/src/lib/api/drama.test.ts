import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiClient: vi.fn() }));
vi.mock('./client', () => ({ apiClient: mocks.apiClient }));
vi.mock('@/lib/perf/drama-observer', () => ({
  dramaTiming: {
    query: (_kind: string, _id: unknown, _video: unknown, run: (cb: () => void) => unknown) =>
      run(() => undefined),
  },
}));
vi.mock('@/lib/perf/request-timing', () => ({ createRequestId: () => 'request' }));

import { loadDramaPlayback, prefetchDramaPlayback, startDramaPlayIntent } from './drama';
import { resetDramaPlaybackCacheForTest } from './drama-playback';
import { playbackConsumption, takePrefetchDiscarded } from '@/lib/drama-playback-resources';

const ID = '11111111-1111-4111-8111-111111111111';
const VIDEO = '22222222-2222-4222-8222-222222222222';
const STREAM = 'https://customer-unit.cloudflarestream.com/token.sig/manifest/video.m3u8';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-STREAM-INF:RESOLUTION=240x426,BANDWIDTH=300000,AUDIO="a"',
  'low.m3u8',
].join('\n');
const CHILD = '#EXTM3U\n#EXTINF:4,\nseg.mp4\n';

const playback = (url: string, extra: Record<string, unknown> = {}) => ({
  playback: {
    video_id: VIDEO,
    playable: true,
    play_url: url,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    ...extra,
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetDramaPlaybackCacheForTest();
  takePrefetchDiscarded();
  mocks.apiClient.mockReset();
  mocks.apiClient.mockImplementation(async () => playback(`https://example.invalid/${Date.now()}`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('取址请求', () => {
  it('POST 固定地址，剧/集/能力声明放在请求体里，并保留 GET 的传输层重试', async () => {
    await loadDramaPlayback(ID, VIDEO, undefined, true);
    const [path, options] = mocks.apiClient.mock.calls[0]!;
    expect(path).toBe('/api/dramas/play');
    expect(options).toMatchObject({ method: 'POST', idempotent: true, queuePriority: 'critical' });
    expect(JSON.parse(options.body)).toEqual({ drama_id: ID, video_id: VIDEO });
  });

  it('可见封面预取走 background 队列，按下封面走 critical', async () => {
    prefetchDramaPlayback(ID, VIDEO, 'visible_cover');
    prefetchDramaPlayback(ID, undefined, 'press_cover', 'critical');
    expect(mocks.apiClient.mock.calls.map(([, o]) => o.queuePriority)).toEqual([
      'background',
      'critical',
    ]);
  });
});

describe('播放资源缓存', () => {
  it('同 (剧, 集) 5 分钟内复用：首次记预取来源，再次使用记 recent', async () => {
    prefetchDramaPlayback(ID, VIDEO, 'visible_cover');
    startDramaPlayIntent(ID, VIDEO); // 点击时的意图接上已有条目，不重复请求
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(60_000);
    const first = await loadDramaPlayback(ID, VIDEO);
    expect(playbackConsumption(first)).toMatchObject({ source: 'visible_cover', ageMs: 60_000 });
    vi.setSystemTime(299_000);
    const again = await loadDramaPlayback(ID, VIDEO);
    expect(again).toBe(first);
    expect(playbackConsumption(again)?.source).toBe('recent');
    expect(mocks.apiClient).toHaveBeenCalledTimes(1);
  });

  it('非封面入口的预取（下一集、下一部、按下选集）按同一键接上，记录各自来源', async () => {
    for (const source of ['next_episode', 'next_drama', 'press_episode'] as const) {
      resetDramaPlaybackCacheForTest();
      mocks.apiClient.mockClear();
      prefetchDramaPlayback(ID, source === 'next_drama' ? undefined : VIDEO, source);
      const consumed = await loadDramaPlayback(ID, source === 'next_drama' ? undefined : VIDEO);
      expect(mocks.apiClient).toHaveBeenCalledTimes(1);
      expect(playbackConsumption(consumed)?.source).toBe(source);
    }
  });

  it('签发超过 5 分钟作废：新建请求，未用过的条目计入丢弃', async () => {
    prefetchDramaPlayback(ID, VIDEO, 'visible_cover');
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(300_001);
    const fresh = await loadDramaPlayback(ID, VIDEO);
    expect(fresh.play_url).toBe('https://example.invalid/300001');
    expect(playbackConsumption(fresh)?.source).toBeUndefined();
    expect(takePrefetchDiscarded()).toEqual({ discardedCount: 1, discardedBytes: 0 });
  });

  it('地址剩余有效期不足 5 分钟时不复用', async () => {
    mocks.apiClient.mockImplementationOnce(async () =>
      playback('https://example.invalid/short', {
        expires_at: new Date(Date.now() + 240_000).toISOString(),
      })
    );
    prefetchDramaPlayback(ID, VIDEO, 'visible_cover');
    await vi.advanceTimersByTimeAsync(0);
    const fresh = await loadDramaPlayback(ID, VIDEO);
    expect(fresh.play_url).not.toBe('https://example.invalid/short');
    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
  });

  it('进行中的请求超过 10 秒视为挂起，重新请求', async () => {
    mocks.apiClient.mockImplementationOnce(() => new Promise(() => undefined));
    startDramaPlayIntent(ID, VIDEO);
    vi.setSystemTime(10_001);
    await loadDramaPlayback(ID, VIDEO);
    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
  });

  it('集不同不接；失败重试绕过并替换缓存', async () => {
    startDramaPlayIntent(ID, VIDEO);
    await loadDramaPlayback(ID, undefined);
    const retried = await loadDramaPlayback(ID, VIDEO, undefined, true);
    expect(mocks.apiClient).toHaveBeenCalledTimes(3);
    // 重试拿到的新地址替换旧条目，之后的播放接上新地址。
    expect(await loadDramaPlayback(ID, VIDEO)).toBe(retried);
    expect(mocks.apiClient).toHaveBeenCalledTimes(3);
  });

  it('请求失败：不缓存；未被接上不产生未处理拒绝，接上的一方拿到原始错误', async () => {
    mocks.apiClient.mockRejectedValueOnce(new Error('network down'));
    startDramaPlayIntent(ID, VIDEO);
    await expect(loadDramaPlayback(ID, VIDEO)).rejects.toThrow('network down');
    await loadDramaPlayback(ID, VIDEO);
    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
    mocks.apiClient.mockRejectedValueOnce(new Error('never adopted'));
    startDramaPlayIntent(ID, undefined);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('不可播结果不缓存', async () => {
    mocks.apiClient.mockImplementationOnce(async () => ({
      playback: { video_id: null, playable: false, play_url: null, expires_at: null },
    }));
    prefetchDramaPlayback(ID, VIDEO, 'visible_cover');
    await vi.advanceTimersByTimeAsync(0);
    await loadDramaPlayback(ID, VIDEO);
    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
  });

  it('Stream 地址带内联主清单时，匿名 CORS 预取最低档和默认音轨两份子清单', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(CHILD));
    vi.stubGlobal('fetch', fetch);
    mocks.apiClient.mockImplementationOnce(async () =>
      playback(STREAM, { format: 'hls', inline_manifest: MASTER })
    );
    prefetchDramaPlayback(ID, VIDEO, 'press_cover', 'critical');
    await vi.advanceTimersByTimeAsync(0);
    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls).toEqual([new URL('low.m3u8', STREAM).href, new URL('audio.m3u8', STREAM).href]);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ mode: 'cors', credentials: 'omit' });

    const consumed = playbackConsumption(await loadDramaPlayback(ID, VIDEO))!;
    expect(consumed.source).toBe('press_cover');
    await expect(consumed.resources.playlists.get(urls[0]!)).resolves.toBe(CHILD);
  });

  it('非 Stream 地址不预取子清单', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    mocks.apiClient.mockImplementationOnce(async () =>
      playback('https://example.invalid/a.m3u8', { format: 'hls', inline_manifest: MASTER })
    );
    prefetchDramaPlayback(ID, VIDEO, 'visible_cover');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
