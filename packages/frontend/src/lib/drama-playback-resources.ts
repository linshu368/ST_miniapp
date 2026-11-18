import type { DramaPlayback, DramaPrefetchSource } from '@miniapp/shared';

/**
 * 播放资源缓存与播放器之间共享的状态。单独成文件、不依赖其他模块：缓存在 `lib/api`，
 * 消费方在 `drama-media-source`/`perf/drama-hls`，放进任何一边都会形成循环引用。
 */

/** 一条缓存条目里起播要用的子清单：按 hls.js 实际请求的绝对 URL 存，值为预取中或已完成的内容。 */
export interface DramaPlaybackResources {
  playlists: Map<string, Promise<string | undefined>>;
}

/** 本次起播从缓存拿到了什么；source 缺省表示地址是现取的（没命中）。 */
export interface DramaPlaybackConsumption {
  resources: DramaPlaybackResources;
  source?: DramaPrefetchSource;
  ageMs?: number;
}

/**
 * 计时按 playback 对象反查取址请求，缓存命中时必须返回同一个对象，所以“这次是否命中”
 * 不能挂在对象上，只能按最近一次消费覆盖记录。播放器拿到地址后立即装载，两者之间不会交错。
 */
const consumptions = new WeakMap<DramaPlayback, DramaPlaybackConsumption>();

export function markPlaybackConsumed(
  playback: DramaPlayback,
  consumption: DramaPlaybackConsumption
): void {
  consumptions.set(playback, consumption);
}

export function playbackConsumption(playback: DramaPlayback): DramaPlaybackConsumption | undefined {
  return consumptions.get(playback);
}

/** loader 实际从缓存应答的子清单，按 hls 实例记录，供起播诊断读取。 */
export interface DramaPrefetchUsage {
  source?: DramaPrefetchSource;
  ageMs?: number;
  playlists: number;
  bytes: number;
}

const usages = new WeakMap<object, DramaPrefetchUsage>();

export function bindPrefetchUsage(hls: object, usage: DramaPrefetchUsage): void {
  usages.set(hls, usage);
}

export function prefetchUsage(hls: object): DramaPrefetchUsage | undefined {
  return usages.get(hls);
}

/** 预取了却没用上就被丢弃的条目；随下一份起播诊断上报后清零，用来估算浪费的流量。 */
let discardedCount = 0;
let discardedBytes = 0;

export function recordPrefetchDiscarded(bytes: number): void {
  discardedCount += 1;
  discardedBytes += bytes;
}

export function takePrefetchDiscarded(): { discardedCount: number; discardedBytes: number } {
  const taken = { discardedCount, discardedBytes };
  discardedCount = 0;
  discardedBytes = 0;
  return taken;
}
