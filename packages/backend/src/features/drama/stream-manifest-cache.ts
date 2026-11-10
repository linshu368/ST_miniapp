// Stream 主清单（m3u8）进程内缓存：按视频 uid 缓存，内容与签名 token 无关
// （2026-11-09 用生产签名配置验证过：同一视频两个不同 token 取到的主清单逐字节相同）。
//
// 只服务 /play 的 Stream 分支；缓存未命中时用当次刚签出的 play_url 去源站拉取，
// 超时或失败一律降级为 undefined，不抛异常、不重试——/play 本身不能因为这层缓存变慢或出错。

import type { SanitizedLogger } from './signed-url.js';

/** 缓存容量上限。当前白名单固定 30 个 uid，留出增长空间 */
const MAX_ENTRIES = 64;

/** 缓存过期时间。内容本身极少变化，只是防止坏条目永久卡住 */
const TTL_MS = 10 * 60 * 1000;

/** 未命中时的拉取超时；超时真正中止请求（AbortSignal），不是只是不等它 */
const FETCH_TIMEOUT_MS = 300;

/** 真实主清单约 1.3KB；留足安全余量，防止源站返回异常大的内容撑爆缓存 */
const MAX_MANIFEST_BYTES = 16 * 1024;

export interface DramaManifestObservation {
  cache?: 'hit' | 'miss' | 'inflight';
}

interface CacheEntry {
  content: string;
  cachedAtMs: number;
}

/** 底层拉取调用，测试时替换 */
export type ManifestFetchFn = (url: string) => Promise<string>;

async function fetchManifest(url: string): Promise<string> {
  // AbortSignal 真正中止请求，不是只是不等它；外层 withTimeout 兜底，
  // 保证注入别的 fetchManifestFn（测试用）时同样受这个超时约束。
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error('drama_manifest_fetch_failed');
  return res.text();
}

/** Release the timer after completion so a resolved call does not retain an idle timeout. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const timeout = new Error('drama_manifest_timeout');
          timeout.name = 'TimeoutError';
          reject(timeout);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class DramaStreamManifestCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | undefined>>();

  constructor(private readonly fetchManifestFn: ManifestFetchFn = fetchManifest) {}

  /**
   * 取某个视频的主清单内容。失败一律降级成 undefined，不抛异常——
   * 拉取抖动不该让 /play 变慢或出错，只是这次响应里少一个可选字段。
   */
  async getManifest(
    uid: string,
    playUrl: string,
    log?: SanitizedLogger,
    observation?: DramaManifestObservation
  ): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.entries.get(uid);
    if (cached && cached.cachedAtMs + TTL_MS > now) {
      if (observation) observation.cache = 'hit';
      return cached.content;
    }
    if (cached) this.entries.delete(uid);

    // 同一个 uid 并发请求只拉一次，其余等同一个 Promise
    const pending = this.inFlight.get(uid);
    if (pending) {
      if (observation) observation.cache = 'inflight';
      return pending;
    }
    if (observation) observation.cache = 'miss';

    const task = this.fetchAndCache(uid, playUrl, log).finally(() => this.inFlight.delete(uid));
    this.inFlight.set(uid, task);
    return task;
  }

  private async fetchAndCache(
    uid: string,
    playUrl: string,
    log?: SanitizedLogger
  ): Promise<string | undefined> {
    try {
      const content = await withTimeout(this.fetchManifestFn(playUrl), FETCH_TIMEOUT_MS);
      // 容量保护是缓存自己的职责，不依赖拉取函数实现是否也做了这个校验。
      if (content.length > MAX_MANIFEST_BYTES) throw new Error('drama_manifest_too_large');
      this.evictIfNeeded();
      this.entries.set(uid, { content, cachedAtMs: Date.now() });
      return content;
    } catch (err) {
      // 只记错误类别，不记 URL/Token
      log?.warn(
        {
          reason:
            err instanceof Error && err.name === 'TimeoutError'
              ? 'drama_manifest_timeout'
              : err instanceof Error && err.message === 'drama_manifest_too_large'
                ? 'drama_manifest_too_large'
                : 'drama_manifest_fetch_failed',
        },
        'drama inline manifest fetch failed'
      );
      return undefined;
    }
  }

  /** 先清过期项，仍然超限就按插入顺序淘汰最旧的 */
  private evictIfNeeded(): void {
    if (this.entries.size < MAX_ENTRIES) return;
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.cachedAtMs + TTL_MS <= now) this.entries.delete(k);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
