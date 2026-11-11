import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DramaStreamManifestCache,
  type DramaManifestObservation,
} from './stream-manifest-cache.js';

// 这几条都是「写错了也不报错、只会悄悄退化」的逻辑：
// 命中判断错了会把过期内容发给用户；single-flight 失效会并发打爆 Stream 源站；
// 未命中时如果又开始等网络，/play 会重新被 Stream 拉取耗时拖慢。

const UID = 'uid-1111';
const OTHER = 'uid-2222';
const URL = 'https://stream.invalid/token/manifest/video.m3u8';
const HOUR = 60 * 60 * 1000;

/** 让已完成的后台拉取写入缓存（拉取函数是立即 resolve 的 async 函数） */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 触发一次未命中并等后台拉取写入缓存 */
async function warm(cache: DramaStreamManifestCache, uid = UID, url = URL) {
  await cache.getManifest(uid, url);
  await flush();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DramaStreamManifestCache', () => {
  it('未命中时立即返回 undefined，不等待拉取；拉取完成后下一次命中', async () => {
    let resolve!: (content: string) => void;
    const cache = new DramaStreamManifestCache(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        })
    );
    const miss: DramaManifestObservation = {};

    // 拉取一直没有返回，/play 也不能被它卡住
    expect(await cache.getManifest(UID, URL, undefined, miss)).toBeUndefined();
    expect(miss.cache).toBe('miss');

    resolve('#EXTM3U');
    await flush();
    const hit: DramaManifestObservation = {};
    expect(await cache.getManifest(UID, URL, undefined, hit)).toBe('#EXTM3U');
    expect(hit.cache).toBe('hit');
  });

  it('TTL 内复用同一份内容，不重复拉取，与签名 token 无关', async () => {
    let calls = 0;
    const cache = new DramaStreamManifestCache(async () => `#EXTM3U\n# call-${++calls}`);

    await warm(cache, UID, 'https://stream.invalid/token/manifest/video.m3u8');
    const second = await cache.getManifest(
      UID,
      'https://stream.invalid/token2/manifest/video.m3u8'
    );

    expect(calls).toBe(1);
    expect(second).toBe('#EXTM3U\n# call-1');
  });

  it('不同 uid 各自缓存，互不串用', async () => {
    const cache = new DramaStreamManifestCache(async (url) => `content-for-${url}`);

    await warm(cache, UID, 'https://stream.invalid/a/manifest/video.m3u8');
    await warm(cache, OTHER, 'https://stream.invalid/b/manifest/video.m3u8');

    expect(await cache.getManifest(UID, URL)).toBe(
      'content-for-https://stream.invalid/a/manifest/video.m3u8'
    );
    expect(await cache.getManifest(OTHER, URL)).toBe(
      'content-for-https://stream.invalid/b/manifest/video.m3u8'
    );
  });

  it('后台拉取进行中，同一个 uid 的其他请求不再发起拉取，标记为 inflight', async () => {
    let calls = 0;
    let resolve!: (content: string) => void;
    const cache = new DramaStreamManifestCache(() => {
      calls++;
      return new Promise<string>((done) => {
        resolve = done;
      });
    });
    const first: DramaManifestObservation = {};
    const second: DramaManifestObservation = {};
    const third: DramaManifestObservation = {};

    const results = await Promise.all([
      cache.getManifest(UID, URL, undefined, first),
      cache.getManifest(UID, URL, undefined, second),
      cache.getManifest(UID, URL, undefined, third),
    ]);

    expect(calls).toBe(1);
    expect(results).toEqual([undefined, undefined, undefined]);
    expect([first.cache, second.cache, third.cache]).toEqual(['miss', 'inflight', 'inflight']);

    resolve('#EXTM3U');
    await flush();
    expect(await cache.getManifest(UID, URL)).toBe('#EXTM3U');
    expect(calls).toBe(1);
  });

  it('6 小时内命中，超过 TTL 后不返回旧内容并重新拉取', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const cache = new DramaStreamManifestCache(async () => `content-${++calls}`);

    await cache.getManifest(UID, URL);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1000);
    expect(await cache.getManifest(UID, URL)).toBe('content-1');

    await vi.advanceTimersByTimeAsync(2000);
    const expired: DramaManifestObservation = {};
    expect(await cache.getManifest(UID, URL, undefined, expired)).toBeUndefined();
    expect(expired.cache).toBe('miss');

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(await cache.getManifest(UID, URL)).toBe('content-2');
  });

  it('容量超限按插入顺序淘汰最旧的', async () => {
    const cache = new DramaStreamManifestCache(async (url) => url);

    for (let i = 0; i < 65; i++) {
      await warm(cache, `uid-${i}`, `${URL}?i=${i}`);
    }

    const evicted: DramaManifestObservation = {};
    await cache.getManifest('uid-0', `${URL}?i=0`, undefined, evicted);
    expect(evicted.cache).toBe('miss');

    const kept: DramaManifestObservation = {};
    await cache.getManifest('uid-64', `${URL}?i=64`, undefined, kept);
    expect(kept.cache).toBe('hit');
  });

  it('拉取失败不抛异常，日志只记类别、不含 URL', async () => {
    const warn = vi.fn();
    const cache = new DramaStreamManifestCache(async () => {
      throw new Error('network down');
    });

    const result = await cache.getManifest(
      UID,
      'https://stream.invalid/secret-token/manifest/video.m3u8',
      { warn }
    );
    await flush();

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('drama_manifest_fetch_failed');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('stream.invalid');
  });

  it('后台拉取 3s 超时后放弃并释放 inflight，即使注入的拉取函数不支持 AbortSignal', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let calls = 0;
    const cache = new DramaStreamManifestCache(() => {
      calls++;
      return new Promise<string>(() => {});
    });

    expect(await cache.getManifest(UID, URL, { warn })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2999);
    const stillWaiting: DramaManifestObservation = {};
    await cache.getManifest(UID, URL, { warn }, stillWaiting);
    expect(stillWaiting.cache).toBe('inflight');

    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('drama_manifest_timeout');

    const retried: DramaManifestObservation = {};
    await cache.getManifest(UID, URL, { warn }, retried);
    expect(retried.cache).toBe('miss');
    expect(calls).toBe(2);
  });

  it('内容过大时拒绝写入缓存', async () => {
    const warn = vi.fn();
    const cache = new DramaStreamManifestCache(async () => 'x'.repeat(16 * 1024 + 1));

    await cache.getManifest(UID, URL, { warn });
    await flush();

    expect(JSON.stringify(warn.mock.calls)).toContain('drama_manifest_too_large');
    const next: DramaManifestObservation = {};
    expect(await cache.getManifest(UID, URL, undefined, next)).toBeUndefined();
    expect(next.cache).toBe('miss');
  });

  it('失败不写入缓存，下次重新尝试', async () => {
    let calls = 0;
    const cache = new DramaStreamManifestCache(async () => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return 'ok';
    });

    await warm(cache);
    expect(await cache.getManifest(UID, URL)).toBeUndefined();
    await flush();
    expect(await cache.getManifest(UID, URL)).toBe('ok');
    expect(calls).toBe(2);
  });
});
