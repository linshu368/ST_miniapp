export type CdnSeekResult = {
  outcome: 'playing' | 'timeout' | 'error' | 'buffered' | 'unknown_buffer' | 'interrupted';
  target_seconds: number;
  buffered: [number, number][];
  target_frame_ms?: number;
  resumed_ms?: number;
  frame_method: 'video_frame_callback' | 'playing_and_timeupdate';
  media_error?: number;
};

/** One bounded seek; observes the actual media, performs no probe or retry. */
export function measureCdnSeek(video: HTMLVideoElement, done: (result: CdnSeekResult) => void) {
  const target = Math.round(video.duration * 0.72 * 10) / 10;
  const buffered: [number, number][] = [];
  let outcome: CdnSeekResult['outcome'] | undefined;
  try {
    if (!Number.isFinite(target) || target <= 0 || video.buffered.length > 16)
      outcome = 'unknown_buffer';
    else
      for (let i = 0; i < video.buffered.length; i++) {
        buffered.push([video.buffered.start(i), video.buffered.end(i)]);
      }
  } catch {
    outcome = 'unknown_buffer';
  }
  const method =
    typeof video.requestVideoFrameCallback === 'function'
      ? 'video_frame_callback'
      : 'playing_and_timeupdate';
  const result: CdnSeekResult = {
    outcome: outcome ?? 'timeout',
    target_seconds: Number.isFinite(target) ? target : 0,
    buffered,
    frame_method: method,
  };
  if (!outcome && buffered.some(([start, end]) => start <= target && end > target))
    outcome = 'buffered';
  if (outcome) {
    done({ ...result, outcome });
    return () => {};
  }
  let ended = false;
  let frameId: number | undefined;
  let firstMediaTime: number | undefined;
  const started = performance.now();
  const finish = (status: CdnSeekResult['outcome']) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
    video.removeEventListener('timeupdate', onTime);
    video.removeEventListener('error', onError);
    document.removeEventListener('visibilitychange', onVisibility);
    done({ ...result, outcome: status, media_error: video.error?.code });
  };
  const frame = (mediaTime: number) => {
    if (ended || video.seeking || video.readyState < 2 || Math.abs(mediaTime - target) > 3) return;
    if (firstMediaTime === undefined) {
      firstMediaTime = mediaTime;
      result.target_frame_ms = Math.round((performance.now() - started) * 10) / 10;
    } else if (mediaTime > firstMediaTime + 0.03 && !video.paused) {
      result.resumed_ms = Math.round((performance.now() - started) * 10) / 10;
      finish('playing');
    }
  };
  const requestFrame = () => {
    try {
      frameId = video.requestVideoFrameCallback((_at, metadata) => {
        frame(metadata.mediaTime);
        if (!ended) requestFrame();
      });
    } catch {
      finish('error');
    }
  };
  const onTime = () => {
    if (method === 'playing_and_timeupdate') frame(video.currentTime);
  };
  const onError = () => finish('error');
  const onVisibility = () => {
    if (document.hidden) finish('interrupted');
  };
  const timer = setTimeout(() => finish('timeout'), 15_000);
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('error', onError);
  document.addEventListener('visibilitychange', onVisibility);
  if (method === 'video_frame_callback') requestFrame();
  if (ended) return () => {};
  video.currentTime = target;
  void video.play().catch(() => finish('error'));
  return () => finish('interrupted');
}
