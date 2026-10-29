import type { DramaDelivery, DramaTimingReport } from '@miniapp/shared';

type End = 'playing' | 'error' | 'switched' | 'left' | 'background' | 'unverified';

/** Passive, one-seek lifetime. It never changes src, currentTime, playback or a media timeout. */
export function observeDramaSeek(
  video: HTMLVideoElement,
  source: string,
  target: number,
  wasPlaying: boolean,
  options: {
    id: string;
    dramaId: string;
    videoId?: string;
    delivery?: DramaDelivery;
    context?: DramaTimingReport['context'];
    now: () => number;
    emit: (report: DramaTimingReport) => void;
  }
): (outcome?: End) => void {
  const startedAt = options.now();
  let ended = false;
  let frameId: number | undefined;
  let seekedMs: number | undefined;
  let frameMs: number | undefined;
  let frameMethod: DramaTimingReport['frameMethod'];
  let frameSupported = typeof video.requestVideoFrameCallback === 'function';
  let buffered: 'yes' | 'no' | 'unknown' = 'unknown';
  try {
    buffered = 'no';
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        buffered = 'unknown';
        break;
      }
      if (start <= target && end > target) buffered = 'yes';
    }
  } catch {
    buffered = 'unknown';
  }
  const current = () => !ended && (video.currentSrc || video.src) === source;
  const emit = (phase: 'start' | 'slow' | 'final', outcome: DramaTimingReport['outcome']) => {
    const elapsed = Math.max(0, options.now() - startedAt);
    try {
      options.emit({
        type: 'seek',
        phase,
        id: options.id,
        dramaId: options.dramaId,
        videoId: options.videoId,
        delivery: options.delivery,
        context: options.context,
        ...(options.context ? { version: 2 as const } : {}),
        outcome,
        elapsedMs: elapsed,
        overFiveSeconds: elapsed > 5000,
        seek: { targetMs: target * 1000, buffered, wasPlaying, seekedMs, frameMs },
        frameMethod,
        marks: {},
        stages: {},
        queries: [],
      });
    } catch {
      /* Optional diagnostics cannot break the progress control. */
    }
  };
  const slow = setTimeout(() => {
    if (!ended) emit('slow', 'waiting');
  }, 5001);
  const finish = (outcome: End = 'switched') => {
    if (ended) return;
    ended = true;
    clearTimeout(slow);
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('error', onError);
    try {
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
    } catch {
      /* A WebView cleanup failure must not interrupt the next seek. */
    }
    emit('final', outcome);
  };
  const onSeeked = () => {
    if (!current()) return;
    seekedMs ??= options.now() - startedAt;
    if (!frameSupported && !wasPlaying) finish('unverified');
  };
  const onTimeUpdate = () => {
    if (
      !current() ||
      frameSupported ||
      seekedMs === undefined ||
      video.seeking ||
      video.paused ||
      video.readyState < 2 ||
      video.currentTime <= target + 0.01
    )
      return;
    frameMs = options.now() - startedAt;
    frameMethod = 'playing_and_timeupdate';
    finish('playing');
  };
  const onError = () => {
    if (current()) finish('error');
  };
  const requestFrame = () => {
    if (!frameSupported || ended) return;
    try {
      frameId = video.requestVideoFrameCallback((_at, metadata) => {
        if (!current()) return;
        // A stale frame callback may survive currentTime assignment. Only accept the target generation.
        if (
          !video.seeking &&
          video.readyState >= 2 &&
          Number.isFinite(metadata.mediaTime) &&
          metadata.mediaTime >= target - 0.25 &&
          Math.abs(metadata.mediaTime - video.currentTime) < 1
        ) {
          frameMs = options.now() - startedAt;
          frameMethod = 'video_frame_callback';
          finish('playing');
        } else requestFrame();
      });
    } catch {
      frameSupported = false;
    }
  };
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('error', onError);
  if (options.context) emit('start', 'waiting');
  requestFrame();
  return finish;
}
