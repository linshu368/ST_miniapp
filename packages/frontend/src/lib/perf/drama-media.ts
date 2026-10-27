import type { DramaPlaybackTiming } from './drama-timing';
import type { DramaMediaEvent, DramaMediaState } from '@miniapp/shared';

function mediaState(video: HTMLVideoElement): DramaMediaState {
  const currentTime = video.currentTime;
  let bufferedAheadMs: number | undefined;
  if (Number.isFinite(currentTime) && currentTime >= 0) {
    try {
      bufferedAheadMs = 0;
      // 只算覆盖当前位置的连续区间；跨缓冲空洞的远端区间不能当作可播缓冲。
      const buffered = video.buffered;
      for (let index = 0; index < buffered.length; index += 1) {
        const start = buffered.start(index);
        const end = buffered.end(index);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          bufferedAheadMs = undefined;
          break;
        }
        if (start <= currentTime && end > currentTime) {
          bufferedAheadMs = Math.round((end - currentTime) * 1000);
          break;
        }
      }
    } catch {
      // 属性不可读表示未知，不能伪装成零缓冲。
      bufferedAheadMs = undefined;
    }
  }
  return {
    readyState: video.readyState,
    networkState: video.networkState,
    paused: video.paused,
    muted: video.muted,
    seeking: video.seeking,
    currentTimeMs:
      Number.isFinite(currentTime) && currentTime >= 0 ? Math.round(currentTime * 1000) : undefined,
    bufferedAheadMs,
    visibility:
      typeof document === 'undefined' ? 'unknown' : document.hidden ? 'hidden' : 'visible',
  };
}

function playError(error: unknown): NonNullable<DramaMediaEvent['error']> {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return 'not_allowed';
    if (error.name === 'AbortError') return 'aborted';
    if (error.name === 'NotSupportedError') return 'not_supported';
  }
  return 'other';
}

/**
 * 每次 src 赋值独立绑定。结束或切换后所有迟到事件/帧回调都失效；
 * 媒体 URL 只用于同源代际校验，绝不送到报告器。
 */
export function observeDramaMedia(
  video: HTMLVideoElement,
  source: string,
  timing: DramaPlaybackTiming
) {
  let disposed = false;
  let playing = false;
  let frame = false;
  let callbackId: number | undefined;
  let useFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  // 本观察器只绑定新 src，旧视频的 currentTime 不能作为新视频的推进基线。
  const initialTime = 0;
  const current = () => !disposed && !timing.outcome && video.currentSrc === source;
  const unbindState = timing.bindMediaState(() =>
    !disposed && video.currentSrc === source ? mediaState(video) : undefined
  );
  const complete = () => {
    if (playing && frame && current()) timing.finish('playing');
  };
  const metadata = () => {
    if (current()) {
      timing.mark('metadata');
      timing.mediaEvent('loadedmetadata');
    }
  };
  const onPlaying = () => {
    if (!current()) return;
    playing = true;
    timing.mark('playing');
    timing.mediaEvent('playing');
    complete();
  };
  const onTimeUpdate = () => {
    if (
      useFrameCallback ||
      !playing ||
      !current() ||
      video.currentTime <= initialTime ||
      video.readyState < 2
    )
      return;
    frame = true;
    timing.frameMethod = 'playing_and_timeupdate';
    timing.mark('first_frame');
    timing.mediaEvent('first_frame');
    complete();
  };
  const error = () => {
    if (current()) timing.finish('error');
  };
  video.addEventListener('loadedmetadata', metadata);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('error', error);
  const diagnosticEvents = [
    'loadeddata',
    'canplay',
    'play',
    'waiting',
    'stalled',
    'suspend',
    'pause',
  ] as const;
  const onDiagnosticEvent = (event: Event) => {
    if (!current()) return;
    const name = diagnosticEvents.find((name) => name === event.type);
    if (!name) return;
    if (name === 'loadeddata' || name === 'canplay') timing.mark(name);
    timing.mediaEvent(name);
  };
  for (const name of diagnosticEvents) video.addEventListener(name, onDiagnosticEvent);

  const requestFrame = () => {
    if (!useFrameCallback) return;
    try {
      callbackId = video.requestVideoFrameCallback(() => {
        if (disposed || timing.outcome) return;
        // 换 src 后第一条回调仍可能属于上一资源，继续等本次资源的帧。
        if (!current() || video.readyState < 2) {
          requestFrame();
          return;
        }
        frame = true;
        timing.frameMethod = 'video_frame_callback';
        timing.mark('first_frame');
        timing.mediaEvent('first_frame');
        complete();
      });
    } catch {
      useFrameCallback = false;
    }
  };
  requestFrame();
  return {
    playCalled(trigger: 'automatic' | 'user') {
      if (disposed || timing.outcome) return;
      timing.mark('play_called');
      timing.mediaEvent('play_called', { trigger });
    },
    resolved(trigger: 'automatic' | 'user') {
      if (disposed || timing.outcome) return;
      timing.mark('play_resolved');
      timing.mediaEvent('play_resolved', { trigger });
    },
    rejected(error: unknown, trigger: 'automatic' | 'user' = 'automatic') {
      if (disposed || timing.outcome) return;
      timing.mark('play_rejected');
      timing.mediaEvent('play_rejected', { trigger, error: playError(error) });
      // 手动 play 的拒绝原本只更新 UI，观测不能增加新的业务终态。
      if (trigger === 'user') return;
      // AbortError 常来自释放旧 src，不能当作网络错误，更不能污染下一次播放。
      if (error instanceof Error && error.name === 'AbortError') return;
      timing.finish(
        error instanceof Error && error.name === 'NotAllowedError' ? 'autoplay_blocked' : 'error'
      );
    },
    dispose() {
      disposed = true;
      unbindState();
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('error', error);
      for (const name of diagnosticEvents) video.removeEventListener(name, onDiagnosticEvent);
      if (callbackId !== undefined && typeof video.cancelVideoFrameCallback === 'function')
        video.cancelVideoFrameCallback(callbackId);
    },
  };
}
