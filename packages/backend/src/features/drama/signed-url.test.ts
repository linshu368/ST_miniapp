import { afterEach, describe, expect, it, vi } from 'vitest';
import { dramaExperimentUser } from './delivery.js';
import {
  DramaSignedUrlCache,
  buildBunnyPlayback,
  type DramaSigningObservation,
} from './signed-url.js';

// 这几条都是「写错了也不报错、只会悄悄退化」的逻辑：
// Token 没复用 → CDN 永远 MISS；single-flight 失效 → 并发打爆 Storage；
// 余量算错 → 把快过期的 URL 发给前端。所以值得钉住。

const PATH = 'videos/11111111-1111-1111-1111-111111111111/original';
const OTHER = 'videos/22222222-2222-2222-2222-222222222222/original';

afterEach(() => {
  vi.useRealTimers();
});

describe('DramaSignedUrlCache', () => {
  it('TTL 内复用同一个签名 URL 原文，并保留原始到期时间', async () => {
    let calls = 0;
    const cache = new DramaSignedUrlCache(async () => `https://cdn/signed?token=t${++calls}`);

    const first = await cache.getPlayUrl(PATH);
    const second = await cache.getPlayUrl(PATH);

    expect(calls).toBe(1);
    expect(second.play_url).toBe(first.play_url);
    // 复用时按当前时刻重算到期就会越刷越远，必须回原值
    expect(second.expires_at).toBe(first.expires_at);
    expect(second.playable).toBe(true);
  });

  it('超过复用窗口后重新签名', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const cache = new DramaSignedUrlCache(async () => `https://cdn/signed?token=t${++calls}`);

    const first = await cache.getPlayUrl(PATH);
    // 复用窗口 = min(签发+1800s, 签发+3600s-60s) = 签发+1800s
    await vi.advanceTimersByTimeAsync(1800_000 - 1000);
    expect((await cache.getPlayUrl(PATH)).play_url).toBe(first.play_url);

    await vi.advanceTimersByTimeAsync(2000);
    const renewed = await cache.getPlayUrl(PATH);

    expect(calls).toBe(2);
    expect(renewed.play_url).not.toBe(first.play_url);
  });

  it('同一对象并发只签一次', async () => {
    let calls = 0;
    const cache = new DramaSignedUrlCache(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return `https://cdn/signed?token=t${calls}`;
    });

    const results = await Promise.all([
      cache.getPlayUrl(PATH),
      cache.getPlayUrl(PATH),
      cache.getPlayUrl(PATH),
    ]);

    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.play_url)).size).toBe(1);
  });

  it('不同对象各自缓存，互不串用', async () => {
    const cache = new DramaSignedUrlCache(async (p) => `https://cdn/${p}?token=x`);

    const a = await cache.getPlayUrl(PATH);
    const b = await cache.getPlayUrl(OTHER);

    expect(a.play_url).not.toBe(b.play_url);
    expect(a.play_url).toContain('11111111');
    expect(b.play_url).toContain('22222222');
  });

  it('签名失败降级成不可播，不抛异常，日志不含路径或 URL', async () => {
    const warn = vi.fn();
    const cache = new DramaSignedUrlCache(async () => {
      throw new Error('drama_sign_failed');
    });

    const result = await cache.getPlayUrl(PATH, { warn });

    expect(result).toEqual({ playable: false, play_url: null, expires_at: null });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('11111111');
    expect(logged).not.toContain('token');
  });

  it('签名超时降级成不可播', async () => {
    vi.useFakeTimers();
    const cache = new DramaSignedUrlCache(() => new Promise<string>(() => {}));

    const pending = cache.getPlayUrl(PATH);
    await vi.advanceTimersByTimeAsync(5000);

    expect(await pending).toEqual({ playable: false, play_url: null, expires_at: null });
  });

  it('失败不写入缓存，下次重新尝试', async () => {
    let calls = 0;
    const cache = new DramaSignedUrlCache(async () => {
      calls++;
      if (calls === 1) throw new Error('drama_sign_failed');
      return 'https://cdn/signed?token=ok';
    });

    expect((await cache.getPlayUrl(PATH)).playable).toBe(false);
    expect((await cache.getPlayUrl(PATH)).playable).toBe(true);
    expect(calls).toBe(2);
  });
  it('observes miss, single-flight waiting and hit without changing the playback contract', async () => {
    let resolve!: (url: string) => void;
    const cache = new DramaSignedUrlCache(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        })
    );
    const miss: DramaSigningObservation = {};
    const waiting: DramaSigningObservation = {};
    const hit: DramaSigningObservation = {};
    const first = cache.getPlayUrl(PATH, undefined, miss);
    const second = cache.getPlayUrl(PATH, undefined, waiting);
    expect(miss.cache).toBe('miss');
    expect(waiting.cache).toBe('inflight');
    resolve('https://example.invalid/media?token=private');
    const result = await first;
    expect(await second).toEqual(result);
    expect(await cache.getPlayUrl(PATH, undefined, hit)).toEqual(result);
    expect(hit.cache).toBe('hit');
    expect(Object.keys(result).sort()).toEqual(['expires_at', 'play_url', 'playable']);
    expect(JSON.stringify([miss, waiting, hit])).not.toContain('private');
  });
});

const CDN_NOW = Date.parse('2026-10-28T13:00:00Z');
function sourceFor(path: string, exp = CDN_NOW / 1000 + 3600) {
  const payload = Buffer.from(JSON.stringify({ url: `drama-videos/${path}`, exp })).toString(
    'base64url'
  );
  return `https://zoqelpfhurwehlvypryl.supabase.co/storage/v1/object/sign/drama-videos/${path}?token=unit.${payload}.signature`;
}

describe('Preview Bunny playback', () => {
  it('keeps user assignment stable across instances and shutdown with domain-separated identity', () => {
    const experiment = {
      id: 'unit-ab',
      key: 'fictional-group-key-for-local-testing-only',
      environment: 'production' as const,
      enabled: true,
    };
    const users = Array.from({ length: 1000 }, (_, id) => dramaExperimentUser(id, experiment));
    expect(users.filter((user) => user.assigned_group === 'bunny').length).toBeGreaterThan(150);
    expect(users.filter((user) => user.assigned_group === 'bunny').length).toBeLessThan(250);
    expect(new Set(users.map((user) => user.experiment_user)).size).toBe(1000);
    expect(dramaExperimentUser(42, { ...experiment, enabled: false })).toEqual(users[42]);
    expect(dramaExperimentUser(42, { ...experiment })).toEqual(users[42]);
    expect(dramaExperimentUser(42, { ...experiment, environment: 'test' })).not.toEqual(users[42]);
    expect(JSON.stringify(users[42])).not.toContain(experiment.key);
  });
  it('accepts production source/prefix and refuses TEST source for that configuration', () => {
    const production = {
      sourceOrigin: 'https://wbtsfzozlmurljvglhpn.supabase.co',
      cdnOrigin: 'https://fictional-production.b-cdn.net',
      pathPrefix: '/production' as const,
    };
    const source = sourceFor(PATH).replace('zoqelpfhurwehlvypryl', 'wbtsfzozlmurljvglhpn');
    expect(
      new URL(buildBunnyPlayback(PATH, source, 'unit-key', CDN_NOW, production).url).pathname
    ).toBe(`/production/${PATH}`);
    expect(() =>
      buildBunnyPlayback(PATH, sourceFor(PATH), 'unit-key', CDN_NOW, production)
    ).toThrow();
  });
  it('does not reuse a cached Bunny capability for an explicitly selected Supabase request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CDN_NOW);
    const cdn = {
      tokenKey: 'fictional-key',
      sourceOrigin: 'https://zoqelpfhurwehlvypryl.supabase.co',
      cdnOrigin: 'https://fictional.b-cdn.net',
      pathPrefix: '/preview-test' as const,
    };
    const sign = vi.fn(async () => sourceFor(PATH));
    const cache = new DramaSignedUrlCache(sign, () => cdn);
    const bunny = await cache.getPlayUrl(PATH, undefined, undefined, cdn);
    const original = await cache.getPlayUrl(PATH, undefined, undefined, null);
    expect(new URL(bunny.play_url!).hostname).toBe('fictional.b-cdn.net');
    expect(original.play_url).toBe(sourceFor(PATH));
    expect((await cache.getPlayUrl(PATH, undefined, undefined, null)).play_url).toBe(
      original.play_url
    );
    expect(sign).toHaveBeenCalledTimes(2);
  });
  it('binds each video and its source capability into a finite CDN URL', () => {
    const first = buildBunnyPlayback(PATH, sourceFor(PATH), 'fictional-cdn-key', CDN_NOW);
    const second = buildBunnyPlayback(OTHER, sourceFor(OTHER), 'fictional-cdn-key', CDN_NOW);
    const url = new URL(first.url);
    expect(url.origin).toBe('https://stminiappvid20261028.b-cdn.net');
    expect(url.pathname).toBe(`/preview-test/${PATH}`);
    expect(url.searchParams.get('origin_token')).toBe(
      new URL(sourceFor(PATH)).searchParams.get('token')
    );
    expect(url.searchParams.get('expires')).toBe(String(CDN_NOW / 1000 + 3540));
    expect(first.expiresAtMs).toBe(CDN_NOW + 3540000);
    expect(second.url).not.toBe(first.url);
    expect(new URL(second.url).searchParams.get('token')).not.toBe(url.searchParams.get('token'));
    expect(first.url).not.toContain('fictional-cdn-key');
    // Cross-language HMAC fixture, calculated independently with Python hashlib.
    expect(url.searchParams.get('token')).toBe('HS256-4lPOqfzuosIRnsowfwE2dh9pkk7ZPSBgCLVw5tlasI0');
  });

  it('refuses other origins, mismatched objects, duplicate query and unsafe paths', () => {
    for (const source of [
      sourceFor(PATH).replace('zoqelpfhurwehlvypryl', 'wbtsfzozlmurljvglhpn'),
      sourceFor(OTHER),
      sourceFor(PATH) + '&token=another',
      sourceFor(PATH) + '&download=1',
      sourceFor(PATH).replace('token=unit.', 'token=malformed'),
    ])
      expect(() => buildBunnyPlayback(PATH, source, 'unit-key', CDN_NOW)).toThrow();
    for (const path of [
      '../original',
      'videos/../original',
      'videos/%2e%2e/original',
      'videos//original',
      'videos/a?x',
    ])
      expect(() => buildBunnyPlayback(path, sourceFor(path), 'unit-key', CDN_NOW)).toThrow();
    expect(() =>
      buildBunnyPlayback(PATH, sourceFor(PATH, CDN_NOW / 1000 + 120), 'unit-key', CDN_NOW)
    ).toThrow('drama_cdn_source_expired');
    expect(() => buildBunnyPlayback(PATH, sourceFor(PATH), '', CDN_NOW)).toThrow();
  });

  it('reuses the complete Bunny URL, renews safely and separates provider credentials', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CDN_NOW);
    let key = 'unit-key';
    const sign = vi.fn(async (path: string) => sourceFor(path, Date.now() / 1000 + 3600));
    const cache = new DramaSignedUrlCache(sign, () => ({
      tokenKey: key,
      sourceOrigin: 'https://zoqelpfhurwehlvypryl.supabase.co',
      cdnOrigin: 'https://stminiappvid20261028.b-cdn.net',
      pathPrefix: '/preview-test',
    }));
    const [first, concurrent] = await Promise.all([cache.getPlayUrl(PATH), cache.getPlayUrl(PATH)]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(concurrent).toEqual(first);
    expect(new URL(first.play_url!).hostname).toBe('stminiappvid20261028.b-cdn.net');
    vi.setSystemTime(CDN_NOW + 1799000);
    expect(await cache.getPlayUrl(PATH)).toEqual(first);
    key = 'rotated-unit-key';
    expect((await cache.getPlayUrl(PATH)).play_url).not.toBe(first.play_url);
    vi.setSystemTime(CDN_NOW + 3600000);
    expect((await cache.getPlayUrl(PATH)).expires_at).not.toBe(first.expires_at);
  });

  it('fails closed for invalid config/source without logging capabilities or falling back', async () => {
    const warn = vi.fn();
    const sign = vi.fn(async () => sourceFor(PATH));
    const broken = new DramaSignedUrlCache(sign, () => {
      throw new Error('private config');
    });
    expect((await broken.getPlayUrl(PATH, { warn })).playable).toBe(false);
    expect(sign).not.toHaveBeenCalled();
    const wrongOrigin = new DramaSignedUrlCache(
      async () => sourceFor(OTHER),
      () => ({
        tokenKey: 'private-key',
        sourceOrigin: 'https://zoqelpfhurwehlvypryl.supabase.co',
        cdnOrigin: 'https://stminiappvid20261028.b-cdn.net',
        pathPrefix: '/preview-test',
      })
    );
    expect((await wrongOrigin.getPlayUrl(PATH, { warn })).playable).toBe(false);
    const thrown = new DramaSignedUrlCache(async () => {
      throw new Error('https://secret.invalid/?token=private');
    });
    expect((await thrown.getPlayUrl(PATH, { warn })).playable).toBe(false);
    const output = JSON.stringify(warn.mock.calls);
    expect(output).not.toContain('private');
    expect(output).not.toContain('token=');
    expect(output).not.toContain('11111111');
  });
});
