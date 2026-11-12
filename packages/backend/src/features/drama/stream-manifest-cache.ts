// Stream 主清单（m3u8）进程内缓存：按视频 uid 缓存，内容与签名 token 无关
// （2026-11-09 用生产签名配置验证过：同一视频两个不同 token 取到的主清单逐字节相同）。
//
// 只服务 /play 的 Stream 分支。未命中时 /play 不等待：本次直接不带内联清单，
// 同时用当次刚签出的 play_url 在后台拉取并写入缓存，供后续请求命中。
// 2026-11-11 生产数据：同步等待 300ms 的旧做法里 71% 的未命中撞超时，既拿不到清单又让 /play
// 多等 300ms，且超时中止后不写缓存，冷视频一直热不起来（命中率仅 13%）。

import type { SanitizedLogger } from './signed-url.js';

/** 缓存容量上限。当前白名单固定 30 个 uid，留出增长空间 */
const MAX_ENTRIES = 64;

/** 缓存过期时间。内容与 token 无关且极少变化；10 分钟在稀疏流量下会频繁过期，命中率上不去 */
const TTL_MS = 6 * 60 * 60 * 1000;

/** 后台拉取超时。不在 /play 关键路径上，可以放宽；超时真正中止请求（AbortSignal） */
const FETCH_TIMEOUT_MS = 3000;

/** 真实主清单约 1.3KB；留足安全余量，防止源站返回异常大的内容撑爆缓存 */
const MAX_MANIFEST_BYTES = 16 * 1024;

/** 启动预热的并发上限：30 个 uid 不必一次性打到 Stream 源站 */
const PREWARM_CONCURRENCY = 4;

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
   * 只返回已缓存的主清单；未命中（含后台拉取进行中）立即返回 undefined，不等网络。
   * 拉取失败只记日志，不抛异常，/play 只是这次响应里少一个可选字段。
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

    // 同一个 uid 同时只有一个后台拉取，避免并发请求打爆 Stream 源站
    if (this.inFlight.has(uid)) {
      if (observation) observation.cache = 'inflight';
      return undefined;
    }
    if (observation) observation.cache = 'miss';

    this.startFetch(uid, playUrl, log);
    return undefined;
  }

  /**
   * 部署会清空进程内缓存，每个视频的首次访问都拿不到内联清单；启动后在后台预先拉好。
   * 已缓存或拉取中的跳过，和 /play 触发的拉取共用 single-flight。不抛异常。
   */
  async prewarm(
    targets: ReadonlyArray<{ uid: string; playUrl: string }>,
    log?: SanitizedLogger
  ): Promise<{ cached: number; failed: number }> {
    const queue = [...targets];
    const result = { cached: 0, failed: 0 };
    const worker = async () => {
      for (let target = queue.shift(); target; target = queue.shift()) {
        const cached = this.entries.get(target.uid);
        const content =
          cached && cached.cachedAtMs + TTL_MS > Date.now()
            ? cached.content
            : await (this.inFlight.get(target.uid) ??
                this.startFetch(target.uid, target.playUrl, log));
        if (content === undefined) result.failed += 1;
        else result.cached += 1;
      }
    };
    await Promise.all(Array.from({ length: PREWARM_CONCURRENCY }, worker));
    return result;
  }

  private startFetch(
    uid: string,
    playUrl: string,
    log?: SanitizedLogger
  ): Promise<string | undefined> {
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
