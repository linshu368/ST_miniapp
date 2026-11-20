import { beforeEach, describe, expect, it, vi } from 'vitest';

// 预取的键必须与目标播放器取址时的键一致，否则缓存静默不命中。
// 首页新 DramaPlayer 的初始集 = 本设备未看完的进度（resumeVideoId），没有就不传集。
const mocks = vi.hoisted(() => ({ resume: new Map<string, string>() }));
vi.mock('@/stores/drama-library-store', () => ({
  resumeVideoId: (id: string) => mocks.resume.get(id),
}));
vi.mock('@/lib/api/drama', () => ({ usePreloadDramaPlayback: () => () => undefined }));
vi.mock('@/lib/background-prefetch', () => ({ canPrefetchInBackground: () => true }));

import { resolveDramaPrefetchTarget } from './use-drama-next-prefetch';

const NEIGHBORS = {
  id: 'drama-a',
  nextPlayableId: 'ep-3',
  previousPlayableId: 'ep-1',
  nextDramaId: 'drama-b',
};

beforeEach(() => mocks.resume.clear());

describe('resolveDramaPrefetchTarget', () => {
  it('剧详情：两个方向都是本剧相邻集，键为 (剧, 集)', () => {
    const neighbors = { ...NEIGHBORS, embedded: false };
    expect(resolveDramaPrefetchTarget(neighbors, 1)).toEqual({
      id: 'drama-a',
      videoId: 'ep-3',
      source: 'next_episode',
    });
    expect(resolveDramaPrefetchTarget(neighbors, -1)).toEqual({
      id: 'drama-a',
      videoId: 'ep-1',
      source: 'next_episode',
    });
  });

  it('剧详情：没有下一集（末集）时不预取', () => {
    expect(
      resolveDramaPrefetchTarget({ ...NEIGHBORS, embedded: false, nextPlayableId: undefined }, 1)
    ).toBeUndefined();
  });

  it('首页：下一部没有进度时不传集', () => {
    expect(resolveDramaPrefetchTarget({ ...NEIGHBORS, embedded: true }, 1)).toEqual({
      id: 'drama-b',
      videoId: undefined,
      source: 'next_drama',
    });
  });

  it('首页：下一部有未看完的进度时用进度里的集', () => {
    mocks.resume.set('drama-b', 'ep-7');
    expect(resolveDramaPrefetchTarget({ ...NEIGHBORS, embedded: true }, 1)?.videoId).toBe('ep-7');
  });

  it('首页：往回滑和队列末尾不预取', () => {
    expect(resolveDramaPrefetchTarget({ ...NEIGHBORS, embedded: true }, -1)).toBeUndefined();
    expect(
      resolveDramaPrefetchTarget({ ...NEIGHBORS, embedded: true, nextDramaId: undefined }, 1)
    ).toBeUndefined();
  });
});
