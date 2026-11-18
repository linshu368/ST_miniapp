'use client';

import type {
  DramaPlayback,
  DramaPlayRequest,
  DramaPrefetchSource,
  GetDramaPlaybackData,
} from '@miniapp/shared';

import { apiClient } from './client';
import { dramaTiming } from '@/lib/perf/drama-observer';
import { capAppleHlsQuality, prefersHlsJs } from '@/lib/drama-media-source';
import { parseDramaStreamOrigin, warmDramaStreamOrigin } from '@/lib/drama-stream-origin';
import { selectStartupPlaylists } from '@/lib/drama-hls-playlist';
import {
  markPlaybackConsumed,
  recordPrefetchDiscarded,
  type DramaPlaybackResources,
} from '@/lib/drama-playback-resources';

export async function fetchDramaPlayback(
  id: string,
  videoId?: string,
  signal?: AbortSignal,
  priority: 'critical' | 'background' = 'critical'
): Promise<DramaPlayback> {
  // 固定地址的 POST：CORS 预检按 URL 缓存，原来每集一个 URL 导致每次都要预检。
  const body: DramaPlayRequest = { drama_id: id };
  if (videoId) body.video_id = videoId;
  if (
    typeof document !== 'undefined' &&
    (document.createElement('video').canPlayType('application/vnd.apple.mpegurl') ||
      typeof MediaSource !== 'undefined')
  )
    body.format = 'hls';
  return dramaTiming.query('playback', id, videoId, async (onAttempt) => {
    const data = await apiClient<GetDramaPlaybackData>('/api/dramas/play', {
      method: 'POST',
      body: JSON.stringify(body),
      // /play 只读，沿用 GET 时的传输层重试，吸收客户端到 Railway 的瞬时抖动。
      idempotent: true,
      onAttempt,
      signal,
      timeoutMs: 5000,
      queuePriority: priority,
    });
    return capAppleHlsQuality(data.playback);
  });
}

/*
 * 播放资源缓存：按 (剧, 请求的集) 保存 /play 结果和起播最先要的两份子清单，
 * 片库可见封面、按下封面、点击意图提前填入，播放器取址时接上；正常取址的结果也留下，
 * 供往回滑和回到同一部复用。
 *
 * 签发超过 MAX_AGE_MS 丢弃：Stream 关闭开关后，新播放最迟这么久回到原路径（11-12 拍板，
 * 原来“每次播放意图都重新取址”的规则据此放宽）。播放失败后的重试一律绕过缓存。
 */
const MAX_AGE_MS = 5 * 60_000;
/** 进行中的请求只接这么久，超过视为挂起，重新请求（与原播放意图的 10s 一致）。 */
const INFLIGHT_TTL_MS = 10_000;
/** 地址剩余有效期不足时不复用，避免播到一半签名过期。 */
const MIN_REMAINING_MS = 5 * 60_000;
/** 每条约 90KB（两份子清单），8 条约 0.7MB 内存。 */
const MAX_ENTRIES = 8;
const PLAYLIST_TIMEOUT_MS = 4000;
/** 真实子清单约 43KB；超过说明返回了异常内容，不缓存。 */
const MAX_PLAYLIST_CHARS = 256 * 1024;

interface CacheEntry {
  promise: Promise<DramaPlayback>;
  source: DramaPrefetchSource;
  startedAt: number;
  resolvedAt?: number;
  expiresAt?: number;
  used: boolean;
  bytes: number;
  resources: DramaPlaybackResources;
}

const entries = new Map<string, CacheEntry>();
const cacheKey = (id: string, videoId?: string) => `${id}:${videoId ?? ''}`;

function usable(entry: CacheEntry, now: number): boolean {
  if (entry.resolvedAt === undefined) return now - entry.startedAt <= INFLIGHT_TTL_MS;
  return (
    now - entry.resolvedAt <= MAX_AGE_MS &&
    (entry.expiresAt === undefined || entry.expiresAt - now >= MIN_REMAINING_MS)
  );
}

function drop(key: string, entry: CacheEntry): void {
  if (entries.get(key) !== entry) return;
  entries.delete(key);
  if (!entry.used) recordPrefetchDiscarded(entry.bytes);
}

function sweep(now: number): void {
  for (const [key, entry] of entries) if (!usable(entry, now)) drop(key, entry);
  // Map 按插入顺序迭代，第一个就是最旧的。
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_ENTRIES) break;
    drop(key, entry);
  }
}

function remember(
  key: string,
  promise: Promise<DramaPlayback>,
  source: DramaPrefetchSource,
  used: boolean
): CacheEntry {
  const previous = entries.get(key);
  if (previous) drop(key, previous);
  const entry: CacheEntry = {
    promise,
    source,
    startedAt: Date.now(),
    used,
    bytes: 0,
    resources: { playlists: new Map() },
  };
  entries.set(key, entry);
  sweep(entry.startedAt);
  promise.then(
    (playback) => {
      if (entries.get(key) !== entry) return;
      if (!playback.playable || !playback.play_url) return void entries.delete(key);
      entry.resolvedAt = Date.now();
      const expiresAt = playback.expires_at ? Date.parse(playback.expires_at) : NaN;
      if (Number.isFinite(expiresAt)) entry.expiresAt = expiresAt;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    }
  );
  return entry;
}

/** 有限超时的子清单请求；与 hls.js 一样走匿名 CORS，复用同一个连接池。失败返回 undefined。 */
async function fetchPlaylist(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAYLIST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    return text.length <= MAX_PLAYLIST_CHARS && text.startsWith('#EXTM3U') ? text : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 只对会走 hls.js 的 Stream 地址预取；没有内联主清单时不额外请求主清单。 */
function prefetchPlaylists(entry: CacheEntry, playback: DramaPlayback): void {
  const url = playback.play_url;
  if (playback.format !== 'hls' || !url || !playback.inline_manifest) return;
  if (!parseDramaStreamOrigin(url) || !prefersHlsJs()) return;
  for (const target of selectStartupPlaylists(playback.inline_manifest, url)) {
    if (entry.resources.playlists.has(target)) continue;
    const pending = fetchPlaylist(target).then((text) => {
      if (text === undefined) entry.resources.playlists.delete(target);
      else entry.bytes += text.length;
      return text;
    });
    entry.resources.playlists.set(target, pending);
  }
}

/**
 * 提前取址并预取子清单。同一 (剧, 集) 已有可用条目时不重复请求。
 * 失败静默丢弃：起播时没有可用条目就走原路径。
 */
export function prefetchDramaPlayback(
  id: string,
  videoId: string | undefined,
  source: DramaPrefetchSource,
  priority: 'critical' | 'background' = 'background'
): void {
  const key = cacheKey(id, videoId);
  sweep(Date.now());
  if (entries.has(key)) return;
  const promise = fetchDramaPlayback(id, videoId, undefined, priority);
  // 没被接上时无人处理拒绝；接上的一方仍会拿到原始拒绝。
  promise.catch(() => undefined);
  const entry = remember(key, promise, source, false);
  void promise.then(
    (playback) => {
      if (entries.get(key) === entry && playback.playable) prefetchPlaylists(entry, playback);
    },
    () => undefined
  );
}

/** 点击当下的播放意图；必须在 dramaTiming.beginPlayback 之后调用，请求才会挂到本次播放观察上。 */
export function startDramaPlayIntent(id: string, videoId?: string): void {
  warmDramaStreamOrigin();
  prefetchDramaPlayback(id, videoId, 'intent', 'critical');
}

/**
 * 播放器取址：同 (剧, 集) 有可用条目就接上（首次使用记来源，再次使用记 recent），
 * 否则新建请求并留作 recent。freshRequest（播放失败后重新签发）绕过并替换缓存。
 */
export function loadDramaPlayback(
  id: string,
  videoId?: string,
  signal?: AbortSignal,
  freshRequest = false
): Promise<DramaPlayback> {
  const key = cacheKey(id, videoId);
  sweep(Date.now());
  const cached = freshRequest ? undefined : entries.get(key);
  if (cached) {
    const source: DramaPrefetchSource = cached.used ? 'recent' : cached.source;
    cached.used = true;
    return cached.promise.then((playback) => {
      markPlaybackConsumed(playback, {
        resources: cached.resources,
        source,
        ageMs: cached.resolvedAt === undefined ? 0 : Math.max(0, Date.now() - cached.resolvedAt),
      });
      return playback;
    });
  }
  const promise = fetchDramaPlayback(id, videoId, signal);
  const entry = remember(key, promise, 'recent', true);
  return promise.then((playback) => {
    markPlaybackConsumed(playback, { resources: entry.resources });
    return playback;
  });
}

/** 仅供测试：清空缓存。 */
export function resetDramaPlaybackCacheForTest(): void {
  entries.clear();
}
