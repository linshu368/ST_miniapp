import type { DramaPlayback, DramaPlaybackEngine } from '@miniapp/shared';
import type HlsPlayer from 'hls.js';
import type { HlsEvents } from '@/lib/perf/drama-hls';
import { createInlinePlaylistLoader } from '@/lib/drama-inline-manifest-loader';
import {
  bindPrefetchUsage,
  playbackConsumption,
  type DramaPrefetchUsage,
} from '@/lib/drama-playback-resources';
import { loadHlsMediaSource } from './hls-media-source';

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

/** 本设备的 HLS 起播是否走 hls.js（与 loadDramaSource 的分支一致，不含加载后的 Hls.isSupported 兜底）。 */
export function prefersHlsJs(): boolean {
  return !isAppleWebKit() || shouldUseHlsOnApple();
}

/** 非 Apple 平台、以及 Apple 平台走 hls.js 时提前拉取 chunk，让首次起播不再等待动态加载；失败时仍在起播时重试。 */
export function preloadDramaHls(): void {
  if (!prefersHlsJs()) return;
  void import('hls.js').catch(() => undefined);
}

/** 主清单内联、或播放资源缓存可用时接管清单请求；两者都没有时用 hls.js 默认 loader。 */
function playlistLoaderFor(source: string, playback: DramaPlayback) {
  const consumption = playbackConsumption(playback);
  const usage: DramaPrefetchUsage = {
    ...(consumption?.source ? { source: consumption.source, ageMs: consumption.ageMs } : {}),
    playlists: 0,
    bytes: 0,
  };
  if (!playback.inline_manifest && !consumption) return { usage };
  return {
    usage,
    pLoader: createInlinePlaylistLoader(
      source,
      playback.inline_manifest,
      consumption && { resources: consumption.resources, usage }
    ),
  };
}

export { ownsHlsMediaSource as ownsDramaSource } from './hls-media-source';

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
  return loadHlsMediaSource(video, playback, ready, failed, onHls, {
    ...options,
    forceHlsOnApple: shouldUseHlsOnApple(),
    restartSeekAudio: true,
    prepareHls: (source) => {
      const { usage, pLoader } = playlistLoaderFor(source, playback);
      return {
        ...(pLoader ? { pLoader } : {}),
        onCreated: (hls) => bindPrefetchUsage(hls, usage),
      };
    },
  });
}
