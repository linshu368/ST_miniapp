// 短剧视频的临时播放地址：签名 + 进程内缓存 + 同 key single-flight。
//
// 这是首次点击到首帧的关键路径。缓存复用的是**同一个签名 URL 原文**（含原 Token）——
// Supabase Smart CDN 对私有桶只有在 Token 一致时才可能命中，换一个新签名就是新对象。
//
// 调用方必须在调用本模块之前完成鉴权、短剧归属校验和可播判定；本模块不做权限判断，
// 只负责签名本身。签名 URL 属于临时凭证：不入库、不进日志、不进错误堆栈。

import type { DramaPlayback } from '@miniapp/shared';
import { getSupabaseClient } from '../../lib/supabase.js';

const BUCKET = 'drama-videos';

/** 向 Supabase 申请的签名有效期 */
const SIGN_TTL_SECONDS = 3600;

/** 缓存复用上限。不等于签名有效期，取两者更小的那个 */
const CACHE_MAX_SECONDS = 1800;

/** 距真实到期至少留这么多余量，避免把快过期的 URL 发给前端 */
const SAFETY_MARGIN_SECONDS = 60;

/** 缓存容量上限，防止无限增长 */
const MAX_ENTRIES = 500;

const SIGN_TIMEOUT_MS = 5000;

/**
 * 授权范围。当前所有通过 Telegram 鉴权的用户可看任意短剧，只有单一范围，
 * 所以这是个常量。将来出现分级权限时在这里按用户/权限组区分，缓存键会跟着隔离，
 * 不需要改别处。
 */
const CACHE_SCOPE = 'authenticated';

/** 本模块的产出：DramaPlayback 去掉由路由填的 video_id */
export type SignedPlayback = Omit<DramaPlayback, 'video_id'>;

const FAILED: SignedPlayback = { playable: false, play_url: null, expires_at: null };

interface CacheEntry {
  url: string;
  /** 签名真实到期时间（毫秒时间戳） */
  expiresAtMs: number;
  /** 本条可被复用到什么时候：min(签发 + 1800s, 真实到期 - 60s) */
  reusableUntilMs: number;
}

/** 底层签名调用，测试时替换 */
export type SignFn = (objectPath: string) => Promise<string>;

async function signWithSupabase(objectPath: string): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .storage.from(BUCKET)
    .createSignedUrl(objectPath, SIGN_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error('drama_sign_failed');
  return data.signedUrl;
}

/** storage-js 的 createSignedUrl 不收 AbortSignal，只能在外层兜一个超时 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('drama_sign_timeout')), ms)),
  ]);
}

/** 只记脱敏的失败原因，不带对象路径、URL 或 Token */
export interface SanitizedLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface DramaSigningObservation {
  cache?: 'hit' | 'miss' | 'inflight';
}

export class DramaSignedUrlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<SignedPlayback>>();

  constructor(private readonly sign: SignFn = signWithSupabase) {}

  /**
   * 取一个可播放地址。失败一律降级成 playable=false，不抛异常 ——
   * 签名抖动不该让详情/列表接口变成 500，也不该污染视频的持久就绪状态。
   */
  async getPlayUrl(
    objectPath: string,
    log?: SanitizedLogger,
    observation?: DramaSigningObservation
  ): Promise<SignedPlayback> {
    const key = `${CACHE_SCOPE}:${objectPath}`;
    const now = Date.now();

    const cached = this.entries.get(key);
    if (cached && cached.reusableUntilMs > now) {
      if (observation) observation.cache = 'hit';
      return {
        playable: true,
        play_url: cached.url,
        // 复用必须回原始到期时间，不能按当前时刻重算
        expires_at: new Date(cached.expiresAtMs).toISOString(),
      };
    }
    if (cached) this.entries.delete(key);

    // 同一个对象并发请求只签一次，其余等同一个 Promise
    const pending = this.inFlight.get(key);
    if (pending) {
      if (observation) observation.cache = 'inflight';
      return pending;
    }
    if (observation) observation.cache = 'miss';

    const task = this.signAndCache(key, objectPath, log).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async signAndCache(
    key: string,
    objectPath: string,
    log?: SanitizedLogger
  ): Promise<SignedPlayback> {
    try {
      const url = await withTimeout(this.sign(objectPath), SIGN_TIMEOUT_MS);
      // createSignedUrl 不回传到期时间，按签发时刻推算；偏保守即可
      const issuedAt = Date.now();
      const expiresAtMs = issuedAt + SIGN_TTL_SECONDS * 1000;
      const reusableUntilMs = Math.min(
        issuedAt + CACHE_MAX_SECONDS * 1000,
        expiresAtMs - SAFETY_MARGIN_SECONDS * 1000
      );

      this.evictIfNeeded();
      this.entries.set(key, { url, expiresAtMs, reusableUntilMs });

      return { playable: true, play_url: url, expires_at: new Date(expiresAtMs).toISOString() };
    } catch (err) {
      // 只记错误码，不记路径/URL/Token
      log?.warn(
        { reason: err instanceof Error ? err.message : 'drama_sign_failed' },
        'drama signed url failed'
      );
      return FAILED;
    }
  }

  /** 先清过期项，仍然超限就按插入顺序淘汰最旧的 */
  private evictIfNeeded(): void {
    if (this.entries.size < MAX_ENTRIES) return;
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.reusableUntilMs <= now) this.entries.delete(k);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
