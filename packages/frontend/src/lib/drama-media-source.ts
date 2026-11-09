import type { DramaPlayback } from '@miniapp/shared';
import type HlsPlayer from 'hls.js';
import type { HlsEvents } from '@/lib/perf/drama-hls';

const owners = new WeakMap<HTMLVideoElement, string>();

/**
 * 只有 Apple 平台的原生 HLS 经过验证。Android WebView 的 canPlayType 也返回非空，
 * 但原生路径的主清单与起播明显更慢，且 buffered 范围不可信（会把未缓冲快进误判为已缓冲）。
 */
function isAppleWebKit(): boolean {
  return typeof navigator !== 'undefined' && /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
}

/**
 * Apple 原生 HLS 总是从主清单第一个档位（多数片是 1080p，首片约 580KB）起播，
 * 且要等首片下完才播。Stream 的 clientBandwidthHint 会把主清单裁成单一档位（不是重排）：
 * 对生产 30 部片实测 2.5 时全部 ≤720p。代价是 iOS 在该流上不再自动切换画质。
 * 必须在取址返回处改写，保证 play_url 在播放、快进监测和拖动进度条之间保持同一个值。
 */
const APPLE_HLS_BANDWIDTH_HINT_MBPS = 2.5;

/** Stream 的视频分片固定 4.000s；续播向下对齐此边界，让 hls.js 第一片直接命中目标分片。 */
export const STREAM_HLS_FRAGMENT_SECONDS = 4;

/** 只对 hls 格式对齐；MP4（Supabase）和精确续播路径保持原值，由调用方决定是否传入对齐后的秒数。 */
export function alignResumeSeconds(seconds: number, format: DramaPlayback['format']): number {
  if (format !== 'hls' || seconds <= 0) return seconds;
  return Math.floor(seconds / STREAM_HLS_FRAGMENT_SECONDS) * STREAM_HLS_FRAGMENT_SECONDS;
}

/**
 * 续播目标秒数的唯一计算入口：临近片尾时重新进入归零（仅非精确续播路径），
 * 否则按 exact 决定是否对齐到分片边界。duration 未知时（起播位置预设阶段）由调用方跳过临近片尾判断。
 */
export function resolveResumeTarget(params: {
  seconds: number;
  duration: number;
  exact: boolean;
  format: DramaPlayback['format'];
}): number {
  const { seconds, duration, exact, format } = params;
  if (!exact && seconds >= duration - 0.5) return 0;
  const clamped = Math.min(seconds, duration);
  return exact ? clamped : alignResumeSeconds(clamped, format);
}

export function capAppleHlsQuality(playback: DramaPlayback): DramaPlayback {
  if (playback.format !== 'hls' || !playback.play_url || !isAppleWebKit()) return playback;
  const joiner = playback.play_url.includes('?') ? '&' : '?';
  return {
    ...playback,
    play_url: `${playback.play_url}${joiner}clientBandwidthHint=${APPLE_HLS_BANDWIDTH_HINT_MBPS}`,
  };
}

/** 非 Apple 平台提前拉取 hls.js chunk，让首次起播不再等待动态加载；失败时仍在起播时重试。 */
export function preloadDramaHls(): void {
  if (isAppleWebKit()) return;
  void import('hls.js').catch(() => undefined);
}

export function ownsDramaSource(video: HTMLVideoElement, source: string): boolean {
  return (video.currentSrc || video.src) === source || owners.get(video) === source;
}

/** The cleanup invalidates pending imports before touching the shared video element. */
export interface LoadDramaSourceOptions {
  /** 续播目标秒数（已按需对齐），写入 hls.js 的 startPosition，让第一片直接拉目标分片。 */
  startPosition?: number;
}

export function loadDramaSource(
  video: HTMLVideoElement,
  playback: DramaPlayback,
  ready: () => void,
  failed: () => void,
  onHls?: (hls: HlsPlayer, events: HlsEvents) => void,
  options?: LoadDramaSourceOptions
) {
  const source = playback.play_url!;
  let disposed = false;
  let destroy: (() => void) | undefined;
  owners.set(video, source);
  const native = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  if (playback.format !== 'hls' || (native && isAppleWebKit())) {
    video.src = source;
    ready();
  } else {
    void import('hls.js')
      .then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          // 没有 MSE 时才退回原生播放器（如部分旧 WebView）。
          if (native) {
            video.src = source;
            ready();
          } else failed();
          return;
        }
        const hls = new Hls({
          manifestLoadingTimeOut: 10000,
          fragLoadingTimeOut: 15000,
          // 从最低档起播并跳过带宽探测分片；ABR 随后自动升档。手机全屏播放器宽度已不会触发尺寸封顶。
          startLevel: 0,
          // -1 是 hls.js 的自动默认值；传入续播秒数让第一片直接请求目标分片，不再先拉 sn0 探测带宽。
          startPosition: options?.startPosition ?? -1,
        });
        destroy = () => hls.destroy();
        try {
          // 必须在 loadSource 之前订阅，否则会漏掉主清单的加载统计。
          onHls?.(hls, Hls.Events);
        } catch {
          /* 诊断不能影响播放 */
        }
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal && !disposed) failed();
        });
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          if (disposed) return;
          hls.loadSource(source);
          ready();
        });
        hls.attachMedia(video);
      })
      .catch(() => {
        if (!disposed) failed();
      });
  }
  return () => {
    disposed = true;
    if (owners.get(video) === source) owners.delete(video);
    destroy?.();
  };
}
