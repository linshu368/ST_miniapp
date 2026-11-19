import type HlsPlayer from 'hls.js';
import type { FragBufferedData, FragLoadedData, FragLoadingData, Fragment } from 'hls.js';
import type { HlsEvents } from '@/lib/perf/drama-hls';

/**
 * 绕过 hls.js 1.7.4 无缓冲快进时“音频等视频”的串行拉取。
 *
 * 音频分片小、常领先视频；buffer-controller 会把领先的音频片挂起，等视频入缓冲到该位置才放行。
 * 快进时 onMediaSeeking 只中止仍在下载的分片，已下载、被挂起的旧音频片不会被中止，
 * 音频控制器停在等它入缓冲，直到目标视频片下载并入缓冲后才请求目标音频片。
 * 生产 Android 约 30% 的无缓冲快进因此串行，P95 4.1s（并行 2.7s）。
 *
 * 只在“目标未缓冲 + 挂着一片不覆盖目标的音频”时用公开 API 重启加载，其余快进不受影响。
 * 被挂起的旧音频片仍在 buffer-controller 队列里，视频入缓冲后照常释放，与现状相同。
 */
export function restartStalledAudioOnSeek(
  hls: HlsPlayer,
  events: HlsEvents,
  video: HTMLVideoElement
): () => void {
  // 音频控制器顺序处理分片，同一时刻至多一片“已下载、未入缓冲”。
  let pending: Fragment | null = null;
  let stopped = false;
  const onLoading = (_event: unknown, { frag }: FragLoadingData) => {
    if (frag.type === 'audio') pending = null;
  };
  const onLoaded = (_event: unknown, { frag }: FragLoadedData) => {
    if (frag.type === 'audio' && typeof frag.sn === 'number') pending = frag;
  };
  const onBuffered = (_event: unknown, { frag }: FragBufferedData) => {
    if (frag === pending) pending = null;
  };
  const onSeeking = () => {
    if (stopped || !pending) return;
    try {
      const target = video.currentTime;
      if (covers(pending, target) || isBuffered(video, target)) return;
      pending = null;
      hls.stopLoad();
      // true：只设定下一次加载位置，不再改写 currentTime。
      hls.startLoad(target, true);
    } catch {
      /* 介入失败等价于现状，不能影响播放。 */
    }
  };
  // 在 MEDIA_ATTACHED 之后挂监听，保证排在 hls.js 自己的 onMediaSeeking 之后。
  const onAttached = () => {
    if (!stopped) video.addEventListener('seeking', onSeeking);
  };
  hls.on(events.FRAG_LOADING, onLoading);
  hls.on(events.FRAG_LOADED, onLoaded);
  hls.on(events.FRAG_BUFFERED, onBuffered);
  hls.on(events.MEDIA_ATTACHED, onAttached);
  return () => {
    if (stopped) return;
    stopped = true;
    pending = null;
    try {
      video.removeEventListener('seeking', onSeeking);
      hls.off(events.FRAG_LOADING, onLoading);
      hls.off(events.FRAG_LOADED, onLoaded);
      hls.off(events.FRAG_BUFFERED, onBuffered);
      hls.off(events.MEDIA_ATTACHED, onAttached);
    } catch {
      /* already destroyed */
    }
  };
}

/** 落点在分片最后这一段时，目标分片装入缓冲后浏览器仍要等下一片才能恢复播放（线上尾段 1–3s）。 */
const SNAP_TAIL_FRACTION = 0.2;
/** 吸附到下一片起点后再往里偏一点，避免浮点误差让 hls.js 仍选中上一片。 */
const SNAP_OFFSET_S = 0.05;
/** 目标分片下载预算：慢样本首字节 P50 约 1.3s，加上 1s 下载和约 0.3s 尾段仍在 3s 内。 */
const SEEK_FRAGMENT_BUDGET_S = 1;
const DEFAULT_FRAGMENT_S = 4;

/**
 * 用户提交无缓冲快进前调用，返回实际要定位的时间。
 *
 * - 落点在分片末尾 20% 时吸附到下一片起点（最多前移约 0.8s），只需下载一片就能恢复。
 * - ABR 平时按“下载时间≈播放时间”选档，快进需要尽快下完一片：给目标分片强制一个按带宽估算
 *   1s 内下完的档位（`nextAutoLevel`，ABR 在该档分片加载成功后自行清除）。
 * - 强制档位要保持到那一片装入缓冲：hls.js 1.7.4 在分片“已下载、未入缓冲”时若档位变了，会按
 *   旧缓冲末端把同一 sn 换高档重下。弱网下 ABR 估算仍偏高，这次重下会在恢复后立刻卡顿
 *   （本地限速复现 3/3 → 保持后 0/3）。所以该档目标分片加载完时再强制一次，
 *   这一片（同一 sn、同一档位）入缓冲后才解除；邻近分片晚到的入缓冲不能提前解除，
 *   之后 ABR 已拿到快进后的真实测速。最多多影响一片。
 *
 * 已缓冲的目标、hls.js 状态缺失或抛错时原值返回，等价于现状。
 */
export function createHlsSeekPlanner(hls: HlsPlayer, events: HlsEvents, video: HTMLVideoElement) {
  let pinned: { level: number; sn: number } | undefined;
  const isPinned = (frag: FragLoadedData['frag']) => {
    const hold = pinned;
    return (
      hold !== undefined && frag.type === 'main' && frag.level === hold.level && frag.sn === hold.sn
    );
  };
  const onLoaded = (_event: unknown, { frag }: FragLoadedData) => {
    if (isPinned(frag) && pinned) hls.nextAutoLevel = pinned.level;
  };
  const onBuffered = (_event: unknown, { frag }: FragBufferedData) => {
    if (isPinned(frag)) pinned = undefined;
  };
  hls.on(events.FRAG_LOADED, onLoaded);
  hls.on(events.FRAG_BUFFERED, onBuffered);
  return {
    plan(target: number): number {
      pinned = undefined;
      try {
        if (isBuffered(video, target) || !hls.levels.length) return target;
        const fragments = currentFragments(hls);
        const planned = snapTarget(fragments, target, video.duration);
        const fragment = fragments.find((frag) => covers(frag, planned));
        const level = forceSeekLevel(hls, fragment?.duration || DEFAULT_FRAGMENT_S);
        pinned =
          level !== undefined && typeof fragment?.sn === 'number'
            ? { level, sn: fragment.sn }
            : undefined;
        return planned;
      } catch {
        return target;
      }
    },
    stop() {
      pinned = undefined;
      try {
        hls.off(events.FRAG_LOADED, onLoaded);
        hls.off(events.FRAG_BUFFERED, onBuffered);
      } catch {
        /* already destroyed */
      }
    },
  };
}

function currentFragments(hls: HlsPlayer): Fragment[] {
  const index = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
  return hls.levels[index]?.details?.fragments ?? [];
}

function snapTarget(fragments: Fragment[], target: number, duration: number): number {
  const index = fragments.findIndex((frag) => covers(frag, target));
  const frag = fragments[index];
  const following = fragments[index + 1];
  if (!frag || !following) return target;
  if (target - frag.start < frag.duration * (1 - SNAP_TAIL_FRACTION)) return target;
  const snapped = following.start + SNAP_OFFSET_S;
  return Number.isFinite(duration) && snapped >= duration ? target : snapped;
}

/** 返回实际强制的档位；不需要强制时返回 undefined。 */
function forceSeekLevel(hls: HlsPlayer, fragmentSeconds: number): number | undefined {
  if (!hls.autoLevelEnabled) return undefined;
  const level = pickSeekLevel(hls, fragmentSeconds);
  if (level >= hls.nextAutoLevel) return undefined;
  hls.nextAutoLevel = level;
  return level;
}

/** 只挑已有子清单的档位，避免为降档多一次子清单请求；都不满足时用最低档。 */
function pickSeekLevel(hls: HlsPlayer, fragmentSeconds: number): number {
  const { levels, minAutoLevel, maxAutoLevel, bandwidthEstimate } = hls;
  if (Number.isFinite(bandwidthEstimate) && bandwidthEstimate > 0) {
    for (let i = Math.min(maxAutoLevel, levels.length - 1); i > minAutoLevel; i--) {
      const level = levels[i];
      if (!level?.details) continue;
      if ((level.maxBitrate * fragmentSeconds) / bandwidthEstimate <= SEEK_FRAGMENT_BUDGET_S)
        return i;
    }
  }
  return minAutoLevel;
}

function covers(frag: Fragment, time: number): boolean {
  return frag.start <= time && time < frag.start + frag.duration;
}

function isBuffered(video: HTMLVideoElement, time: number): boolean {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++)
    if (ranges.start(i) <= time && time < ranges.end(i)) return true;
  return false;
}
