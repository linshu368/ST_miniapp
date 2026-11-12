import type { DramaPlayback, DramaPlaybackEngine } from '@miniapp/shared';
import type HlsPlayer from 'hls.js';
import type { MediaAttachedData } from 'hls.js';
import type { HlsEvents } from '@/lib/perf/drama-hls';
import { createInlinePlaylistLoader } from '@/lib/drama-inline-manifest-loader';
import { restartStalledAudioOnSeek } from '@/lib/drama-hls-seek';

const owners = new WeakMap<HTMLVideoElement, string>();

/**
 * 只有 Apple 平台的原生 HLS 经过验证。Android WebView 的 canPlayType 也返回非空，
 * 但原生路径的主清单与起播明显更慢，且 buffered 范围不可信（会把未缓冲快进误判为已缓冲）。
 */
function isAppleWebKit(): boolean {
  return typeof navigator !== 'undefined' && /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
}

/** ManagedMediaSource 是否存在是同步能力检测，不依赖 hls.js 异步加载完成。 */
function hasManagedMediaSource(): boolean {
  return typeof window !== 'undefined' && 'ManagedMediaSource' in window;
}

/**
 * 唯一判断源：capAppleHlsQuality（取地址）和 loadDramaSource（装载）都调用这个函数，
 * 保证同一次播放对“走不走 hls.js”的判断一致，不会出现 play_url 和实际装载路径不匹配。
 * iOS 17.1 以下、WKWebView 不支持 ManagedMediaSource 时自动落到现状的原生分支。
 */
export function shouldUseHlsOnApple(): boolean {
  return (
    isAppleWebKit() && hasManagedMediaSource() && process.env.NEXT_PUBLIC_DRAMA_IOS_HLSJS === 'true'
  );
}

/**
 * Apple 原生 HLS 总是从主清单第一个档位（多数片是 1080p，首片约 580KB）起播，
 * 且要等首片下完才播。Stream 的 clientBandwidthHint 会把主清单裁成单一档位（不是重排）：
 * 对生产 30 部片实测 2.5 时全部 ≤720p。代价是 iOS 在该流上不再自动切换画质。
 * 必须在取址返回处改写，保证 play_url 在播放、快进监测和拖动进度条之间保持同一个值。
 * 走 hls.js 的 Apple 设备不裁清单：先看实际画质，iOS 和 Android 一样从最低档起播再升档。
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
  if (playback.format !== 'hls' || !playback.play_url || !isAppleWebKit() || shouldUseHlsOnApple())
    return playback;
  const joiner = playback.play_url.includes('?') ? '&' : '?';
  return {
    ...playback,
    play_url: `${playback.play_url}${joiner}clientBandwidthHint=${APPLE_HLS_BANDWIDTH_HINT_MBPS}`,
  };
}

/** 非 Apple 平台、以及 Apple 平台走 hls.js 时提前拉取 chunk，让首次起播不再等待动态加载；失败时仍在起播时重试。 */
export function preloadDramaHls(): void {
  if (isAppleWebKit() && !shouldUseHlsOnApple()) return;
  void import('hls.js').catch(() => undefined);
}

/** 按 hls.js 实际 attach 的 MediaSource 构造器区分 MSE/MMS，不用开关值推测。 */
function hlsEngineFromMediaSource(
  mediaSource: MediaAttachedData['mediaSource']
): DramaPlaybackEngine {
  const MMS = (window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource;
  return typeof MMS === 'function' && mediaSource instanceof (MMS as new () => unknown)
    ? 'hlsjs_mms'
    : 'hlsjs_mse';
}

export function ownsDramaSource(video: HTMLVideoElement, source: string): boolean {
  return (video.currentSrc || video.src) === source || owners.get(video) === source;
}

/** The cleanup invalidates pending imports before touching the shared video element. */
export interface LoadDramaSourceOptions {
  /** 续播目标秒数（已按需对齐），写入 hls.js 的 startPosition，让第一片直接拉目标分片。 */
  startPosition?: number;
  /** 实际装载的播放引擎确定后回调，供诊断打点。 */
  onEngine?: (engine: DramaPlaybackEngine) => void;
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
  const useNative =
    playback.format !== 'hls' || (native && isAppleWebKit() && !shouldUseHlsOnApple());
  if (useNative) {
    video.src = source;
    options?.onEngine?.(playback.format !== 'hls' ? 'native_file' : 'native_hls');
    ready();
  } else {
    void import('hls.js')
      .then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          // 没有 MSE 时才退回原生播放器（如部分旧 WebView）。
          if (native) {
            video.src = source;
            options?.onEngine?.('native_hls');
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
          // 后端随 /play 内联了主清单时，跳过这一次真实网络请求；子清单/分片仍走真实网络。
          ...(playback.inline_manifest
            ? { pLoader: createInlinePlaylistLoader(source, playback.inline_manifest) }
            : {}),
        });
        const stopSeekRestart = restartStalledAudioOnSeek(hls, Hls.Events, video);
        destroy = () => {
          stopSeekRestart();
          hls.destroy();
        };
        try {
          // 必须在 loadSource 之前订阅，否则会漏掉主清单的加载统计。
          onHls?.(hls, Hls.Events);
        } catch {
          /* 诊断不能影响播放 */
        }
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal && !disposed) failed();
        });
        hls.on(Hls.Events.MEDIA_ATTACHED, (_event, data) => {
          if (disposed) return;
          try {
            options?.onEngine?.(hlsEngineFromMediaSource(data.mediaSource));
          } catch {
            /* 诊断不能影响播放 */
          }
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
