import type { DramaPlaybackTiming } from './drama-timing';

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
  const complete = () => {
    if (playing && frame && current()) timing.finish('playing');
  };
  const metadata = () => {
    if (current()) timing.mark('metadata');
  };
  const onPlaying = () => {
    if (!current()) return;
    playing = true;
    timing.mark('playing');
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
    complete();
  };
  const error = () => {
    if (current()) timing.finish('error');
  };
  video.addEventListener('loadedmetadata', metadata);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('error', error);

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
        complete();
      });
    } catch {
      useFrameCallback = false;
    }
  };
  requestFrame();
  return {
    rejected(error: unknown) {
      if (disposed || timing.outcome) return;
      // AbortError 常来自释放旧 src，不能当作网络错误，更不能污染下一次播放。
      if (error instanceof Error && error.name === 'AbortError') return;
      timing.finish(
        error instanceof Error && error.name === 'NotAllowedError' ? 'autoplay_blocked' : 'error'
      );
    },
    dispose() {
      disposed = true;
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('error', error);
      if (callbackId !== undefined && typeof video.cancelVideoFrameCallback === 'function')
        video.cancelVideoFrameCallback(callbackId);
    },
  };
}
