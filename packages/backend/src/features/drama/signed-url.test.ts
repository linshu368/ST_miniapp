import { afterEach, describe, expect, it, vi } from 'vitest';
import { DramaSignedUrlCache } from './signed-url.js';

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
});
