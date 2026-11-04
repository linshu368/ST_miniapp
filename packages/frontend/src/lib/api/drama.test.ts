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

import { loadDramaPlayback, startDramaPlayIntent } from './drama';

const ID = '11111111-1111-4111-8111-111111111111';
const VIDEO = '22222222-2222-4222-8222-222222222222';
const playback = (url: string) => ({
  playback: { video_id: VIDEO, playable: true, play_url: url },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  mocks.apiClient.mockReset();
  mocks.apiClient.mockImplementation(async () => playback(`https://example.invalid/${Date.now()}`));
});
afterEach(() => vi.useRealTimers());

describe('播放意图请求', () => {
  it('POST 固定地址，剧/集/能力声明放在请求体里，并保留 GET 的传输层重试', async () => {
    await loadDramaPlayback(ID, VIDEO, undefined, true);
    const [path, options] = mocks.apiClient.mock.calls[0]!;
    expect(path).toBe('/api/dramas/play');
    expect(options).toMatchObject({ method: 'POST', idempotent: true, queuePriority: 'critical' });
    expect(JSON.parse(options.body)).toEqual({
      drama_id: ID,
      video_id: VIDEO,
      fallback: 'mp4',
    });
  });

  it('被接上：同 (剧, 集) 10 秒内复用这次请求，并且只用一次', async () => {
    startDramaPlayIntent(ID, VIDEO);
    vi.setSystemTime(9_999);
    const adopted = await loadDramaPlayback(ID, VIDEO);
    expect(adopted.play_url).toBe('https://example.invalid/0');
    expect(mocks.apiClient).toHaveBeenCalledTimes(1);
    // 第二次没有可接的意图，必须重新取址（每次播放意图都要确认当前投放路径）。
    await loadDramaPlayback(ID, VIDEO);
    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
  });

  it('过期作废：超过 10 秒新建请求', async () => {
    startDramaPlayIntent(ID, VIDEO);
    vi.setSystemTime(10_001);
    const fresh = await loadDramaPlayback(ID, VIDEO);
    expect(fresh.play_url).toBe('https://example.invalid/10001');
    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
  });

  it('接不上：集不同、或回退 MP4 都新建请求，且不消耗原意图', async () => {
    startDramaPlayIntent(ID, VIDEO);
    await loadDramaPlayback(ID, undefined);
    await loadDramaPlayback(ID, VIDEO, undefined, true);
    expect(mocks.apiClient).toHaveBeenCalledTimes(3);
    await loadDramaPlayback(ID, VIDEO);
    expect(mocks.apiClient).toHaveBeenCalledTimes(3);
  });

  it('意图请求失败：未被接上不产生未处理拒绝，接上的一方拿到原始错误', async () => {
    mocks.apiClient.mockRejectedValueOnce(new Error('network down'));
    startDramaPlayIntent(ID, VIDEO);
    await expect(loadDramaPlayback(ID, VIDEO)).rejects.toThrow('network down');
    mocks.apiClient.mockRejectedValueOnce(new Error('never adopted'));
    startDramaPlayIntent(ID, undefined);
    await vi.advanceTimersByTimeAsync(0);
  });
});
