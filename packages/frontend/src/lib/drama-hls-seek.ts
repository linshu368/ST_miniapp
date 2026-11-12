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

function covers(frag: Fragment, time: number): boolean {
  return frag.start <= time && time < frag.start + frag.duration;
}

function isBuffered(video: HTMLVideoElement, time: number): boolean {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++)
    if (ranges.start(i) <= time && time < ranges.end(i)) return true;
  return false;
}
