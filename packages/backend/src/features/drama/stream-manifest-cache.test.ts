import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DramaStreamManifestCache,
  type DramaManifestObservation,
} from './stream-manifest-cache.js';

// 这几条都是「写错了也不报错、只会悄悄退化」的逻辑：
// 命中判断错了会把过期内容发给用户；single-flight 失效会并发打爆 Stream 源站；
// 超时写错会让 /play 被真实网络抖动拖慢而不是稳定降级。

const UID = 'uid-1111';
const OTHER = 'uid-2222';

afterEach(() => {
  vi.useRealTimers();
});

describe('DramaStreamManifestCache', () => {
  it('TTL 内复用同一份内容，不重复拉取', async () => {
    let calls = 0;
    const cache = new DramaStreamManifestCache(async () => `#EXTM3U\n# call-${++calls}`);

    const first = await cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8');
    const second = await cache.getManifest(
      UID,
      'https://stream.invalid/token2/manifest/video.m3u8'
    );

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it('不同 uid 各自缓存，互不串用', async () => {
    const cache = new DramaStreamManifestCache(async (url) => `content-for-${url}`);

    const a = await cache.getManifest(UID, 'https://stream.invalid/a/manifest/video.m3u8');
    const b = await cache.getManifest(OTHER, 'https://stream.invalid/b/manifest/video.m3u8');

    expect(a).not.toBe(b);
  });

  it('同一个 uid 并发请求只拉一次', async () => {
    let calls = 0;
    const cache = new DramaStreamManifestCache(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return `content-${calls}`;
    });

    const results = await Promise.all([
      cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8'),
      cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8'),
      cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8'),
    ]);

    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('observes miss、inflight 和 hit，不改变返回内容', async () => {
    let resolve!: (content: string) => void;
    const cache = new DramaStreamManifestCache(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        })
    );
    const miss: DramaManifestObservation = {};
    const waiting: DramaManifestObservation = {};
    const hit: DramaManifestObservation = {};
    const first = cache.getManifest(
      UID,
      'https://stream.invalid/token/manifest/video.m3u8',
      undefined,
      miss
    );
    const second = cache.getManifest(
      UID,
      'https://stream.invalid/token/manifest/video.m3u8',
      undefined,
      waiting
    );
    expect(miss.cache).toBe('miss');
    expect(waiting.cache).toBe('inflight');
    resolve('#EXTM3U');
    const result = await first;
    expect(await second).toBe(result);
    expect(
      await cache.getManifest(
        UID,
        'https://stream.invalid/token/manifest/video.m3u8',
        undefined,
        hit
      )
    ).toBe(result);
    expect(hit.cache).toBe('hit');
  });

  it('超过 TTL 后重新拉取', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const cache = new DramaStreamManifestCache(async () => `content-${++calls}`);

    const first = await cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1000);
    expect(await cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8')).toBe(
      first
    );

    await vi.advanceTimersByTimeAsync(2000);
    const renewed = await cache.getManifest(
      UID,
      'https://stream.invalid/token/manifest/video.m3u8'
    );
    expect(calls).toBe(2);
    expect(renewed).not.toBe(first);
  });

  it('容量超限按插入顺序淘汰最旧的', async () => {
    const cache = new DramaStreamManifestCache(async (url) => url);
    const base = 'https://stream.invalid/token/manifest/video.m3u8';

    for (let i = 0; i < 65; i++) {
      await cache.getManifest(`uid-${i}`, `${base}?i=${i}`);
    }

    const evicted: DramaManifestObservation = {};
    await cache.getManifest('uid-0', `${base}?i=0`, undefined, evicted);
    expect(evicted.cache).toBe('miss');

    const kept: DramaManifestObservation = {};
    await cache.getManifest('uid-64', `${base}?i=64`, undefined, kept);
    expect(kept.cache).toBe('hit');
  });

  it('拉取失败降级成 undefined，不抛异常，日志不含 URL', async () => {
    const warn = vi.fn();
    const cache = new DramaStreamManifestCache(async () => {
      throw new Error('network down');
    });

    const result = await cache.getManifest(
      UID,
      'https://stream.invalid/secret-token/manifest/video.m3u8',
      { warn }
    );

    expect(result).toBeUndefined();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('stream.invalid');
  });

  it('超时降级成 undefined，即使注入的拉取函数不支持 AbortSignal', async () => {
    vi.useFakeTimers();
    const cache = new DramaStreamManifestCache(() => new Promise<string>(() => {}));

    const pending = cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8');
    await vi.advanceTimersByTimeAsync(300);

    expect(await pending).toBeUndefined();
  });

  it('内容过大时拒绝写入缓存并降级', async () => {
    const warn = vi.fn();
    const cache = new DramaStreamManifestCache(async () => 'x'.repeat(16 * 1024 + 1));

    const result = await cache.getManifest(
      UID,
      'https://stream.invalid/token/manifest/video.m3u8',
      { warn }
    );

    expect(result).toBeUndefined();
  });

  it('失败不写入缓存，下次重新尝试', async () => {
    let calls = 0;
    const cache = new DramaStreamManifestCache(async () => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return 'ok';
    });

    expect(
      await cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8')
    ).toBeUndefined();
    expect(await cache.getManifest(UID, 'https://stream.invalid/token/manifest/video.m3u8')).toBe(
      'ok'
    );
    expect(calls).toBe(2);
  });
});
