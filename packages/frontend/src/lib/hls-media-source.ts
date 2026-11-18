import type { DramaPlaybackEngine } from '@miniapp/shared';
import type HlsPlayer from 'hls.js';
import type { MediaAttachedData } from 'hls.js';
import type { HlsEvents } from '@/lib/perf/drama-hls';
import { createInlinePlaylistLoader } from '@/lib/drama-inline-manifest-loader';
import { restartStalledAudioOnSeek } from '@/lib/drama-hls-seek';
const owners = new WeakMap<HTMLVideoElement, string>();
export interface MediaPlayback {
  format?: 'hls' | 'mp4';
  play_url: string | null;
  inline_manifest?: string;
}
export interface HlsMediaSourceOptions {
  startPosition?: number;
  onEngine?: (engine: DramaPlaybackEngine) => void;
  forceHlsOnApple?: boolean;
  restartSeekAudio?: boolean;
}
function isAppleWebKit() {
  return typeof navigator !== 'undefined' && /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
}
function hlsEngineFromMediaSource(
  mediaSource: MediaAttachedData['mediaSource']
): DramaPlaybackEngine {
  const MMS = (window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource;
  return typeof MMS === 'function' && mediaSource instanceof (MMS as new () => unknown)
    ? 'hlsjs_mms'
    : 'hlsjs_mse';
}

export function ownsHlsMediaSource(video: HTMLVideoElement, source: string): boolean {
  return (video.currentSrc || video.src) === source || owners.get(video) === source;
}

export function loadHlsMediaSource(
  video: HTMLVideoElement,
  playback: MediaPlayback,
  ready: () => void,
  failed: () => void,
  onHls?: (hls: HlsPlayer, events: HlsEvents) => void,
  options?: HlsMediaSourceOptions
) {
  const source = playback.play_url!;
  let disposed = false;
  let destroy: (() => void) | undefined;
  owners.set(video, source);
  const native = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  const useNative =
    playback.format !== 'hls' || (native && isAppleWebKit() && !options?.forceHlsOnApple);
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
        const stopSeekRestart = options?.restartSeekAudio
          ? restartStalledAudioOnSeek(hls, Hls.Events, video)
          : () => undefined;
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
