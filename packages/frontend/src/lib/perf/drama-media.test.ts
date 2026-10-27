import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';
import { observeDramaMedia } from './drama-media';
import { DRAMA_TIMING_MAX_MEDIA_EVENTS, DramaTimingReportSchema } from '@miniapp/shared';

class Video extends EventTarget {
  currentSrc = 'media-a';
  currentTime = 0;
  readyState = 2;
  networkState = 2;
  paused = true;
  muted = false;
  seeking = false;
  buffered = { length: 1, start: () => 0, end: () => 3 };
  frame?: () => void;
  requestVideoFrameCallback: ((callback: () => void) => number) | undefined = (callback) => {
    this.frame = callback;
    return 1;
  };
  cancelVideoFrameCallback = vi.fn();
}
let reports: DramaTimingReport[];
let video: Video;
let tracker: DramaTimingTracker;
const bind = () =>
  observeDramaMedia(video as unknown as HTMLVideoElement, 'media-a', tracker.ensurePlayback('a'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  reports = [];
  video = new Video();
  tracker = new DramaTimingTracker(
    () => performance.now(),
    () => 'id',
    (report) => reports.push(report)
  );
  tracker.beginPlayback('a', 'cover').mark('source_set');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('video startup observation', () => {
  it('reports startup milestones, sanitized play results and live slow/final state', async () => {
    const observer = bind();
    observer.playCalled('automatic');
    await vi.advanceTimersByTimeAsync(100);
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('canplay'));
    observer.resolved('automatic');
    video.currentTime = 1;
    await vi.advanceTimersByTimeAsync(9900);
    const slow = reports[0]!;
    expect(slow).toMatchObject({
      phase: 'slow',
      marks: { play_called: 0, metadata: 100, loadeddata: 100, canplay: 100, play_resolved: 100 },
      media: {
        snapshot: {
          readyState: 2,
          networkState: 2,
          paused: true,
          currentTimeMs: 1000,
          bufferedAheadMs: 2000,
        },
      },
    });
    const slowEvents = slow.media!.events.slice();
    video.currentTime = 2;
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(reports[1]).toMatchObject({
      outcome: 'playing',
      media: { snapshot: { paused: false, currentTimeMs: 2000, bufferedAheadMs: 1000 } },
    });
    expect(slow.media!.events).toEqual(slowEvents);
    expect(slow.media!.snapshot!.currentTimeMs).toBe(1000);
    expect(DramaTimingReportSchema.safeParse(reports[1]).success).toBe(true);
    expect(JSON.stringify(reports)).not.toContain('media-a');
  });

  it('counts only continuous buffer ahead and treats unreadable TimeRanges as unknown', async () => {
    video.currentTime = 2;
    video.buffered = {
      length: 2,
      start: (i = 0) => (i === 0 ? 0 : 5),
      end: (i = 0) => (i === 0 ? 1 : 10),
    };
    bind();
    video.dispatchEvent(new Event('waiting'));
    video.currentTime = 5.5;
    video.dispatchEvent(new Event('stalled'));
    Object.defineProperty(video, 'buffered', {
      get() {
        throw new Error('private-details');
      },
    });
    video.dispatchEvent(new Event('suspend'));
    await vi.advanceTimersByTimeAsync(10_000);
    const events = reports[0]!.media!.events;
    expect(events.map((event) => event.state?.bufferedAheadMs)).toEqual([0, 4500, undefined]);
    expect(reports[0]!.media!.snapshot?.bufferedAheadMs).toBeUndefined();
    expect(JSON.stringify(reports)).not.toContain('private-details');
    expect(DramaTimingReportSchema.safeParse(reports[0]).success).toBe(true);
  });

  it('omits non-finite media position/buffer and captures visibility at background termination', () => {
    bind();
    video.currentTime = NaN;
    video.dispatchEvent(new Event('waiting'));
    video.currentTime = 0;
    video.buffered = { length: 1, start: () => 0, end: () => Infinity };
    vi.stubGlobal('document', { hidden: true });
    tracker.background();
    expect(reports[0]).toMatchObject({
      outcome: 'background',
      media: { snapshot: { currentTimeMs: 0, visibility: 'hidden' } },
    });
    expect(reports[0]!.media!.events[0]!.state?.currentTimeMs).toBeUndefined();
    expect(reports[0]!.media!.snapshot?.bufferedAheadMs).toBeUndefined();
    expect(reports[0]!.media!.events.at(-1)?.name).toBe('visibility_hidden');
    expect(DramaTimingReportSchema.safeParse(reports[0]).success).toBe(true);
  });

  it('keeps playing when media state access throws and ignores diagnostics after dispose', () => {
    const observer = bind();
    Object.defineProperty(video, 'networkState', {
      get() {
        throw new Error('unreadable');
      },
    });
    expect(() => observer.playCalled('automatic')).not.toThrow();
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(reports[0]?.outcome).toBe('playing');
    expect(reports[0]?.media?.snapshot).toBeUndefined();
    observer.dispose();
    observer.resolved('automatic');
    observer.playCalled('user');
    video.dispatchEvent(new Event('waiting'));
    expect(reports).toHaveLength(1);
  });

  it('bounds noisy events while retaining milestone marks and terminal state', async () => {
    bind();
    for (let i = 0; i < DRAMA_TIMING_MAX_MEDIA_EVENTS + 3; i += 1)
      video.dispatchEvent(new Event('waiting'));
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('canplay'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports[0]!.media!.events).toHaveLength(DRAMA_TIMING_MAX_MEDIA_EVENTS);
    expect(reports[0]).toMatchObject({
      marks: { loadeddata: 0, canplay: 0 },
      media: { eventsTruncated: true, snapshot: { readyState: 2 } },
    });
    expect(DramaTimingReportSchema.safeParse(reports[0]).success).toBe(true);
  });

  it('records user calls/rejections without changing manual-play termination behavior', () => {
    const observer = bind();
    tracker.ensurePlayback('a').mediaEvent('user_play');
    observer.playCalled('user');
    observer.rejected(new DOMException('private-url', 'NotAllowedError'), 'user');
    expect(reports).toHaveLength(0);
    tracker.ensurePlayback('a').mediaEvent('user_pause');
    tracker.background('pagehide');
    expect(reports[0]).toMatchObject({
      outcome: 'background',
      media: {
        events: [
          expect.objectContaining({ name: 'user_play' }),
          expect.objectContaining({ name: 'play_called', trigger: 'user' }),
          expect.objectContaining({ name: 'play_rejected', trigger: 'user', error: 'not_allowed' }),
          expect.objectContaining({ name: 'user_pause' }),
          expect.objectContaining({ name: 'pagehide' }),
        ],
      },
    });
    expect(JSON.stringify(reports)).not.toContain('private-url');
  });

  it('does not let disposed Promise results or events enter a new retry observation', () => {
    const previous = bind();
    previous.dispose();
    const retry = tracker.beginPlayback('a', 'retry');
    retry.mediaEvent('user_retry');
    const observer = bind();
    previous.resolved('automatic');
    previous.rejected(new DOMException('late', 'NotAllowedError'));
    observer.playCalled('automatic');
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(reports.at(-1)).toMatchObject({ entry: 'retry', outcome: 'playing' });
    expect(reports.at(-1)!.media!.events.map((event) => event.name)).toEqual([
      'user_retry',
      'play_called',
      'playing',
      'first_frame',
    ]);
  });

  it('requires a frame AND playing; metadata/canplay alone never count as success', async () => {
    bind();
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('canplay'));
    video.frame?.();
    expect(reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    video.dispatchEvent(new Event('playing'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: 'playing',
      elapsedMs: 200,
      frameMethod: 'video_frame_callback',
      marks: { first_frame: 0, playing: 200 },
    });
  });

  it('waits for the actual frame if playing fires first', () => {
    bind();
    video.dispatchEvent(new Event('playing'));
    expect(reports).toHaveLength(0);
    video.frame?.();
    video.dispatchEvent(new Event('playing'));
    expect(reports).toHaveLength(1);
  });

  it('falls back to playing plus advancing currentTime in older WebViews', () => {
    video.requestVideoFrameCallback = undefined;
    bind();
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('timeupdate'));
    expect(reports).toHaveLength(0);
    video.currentTime = 0.1;
    video.dispatchEvent(new Event('timeupdate'));
    expect(reports[0]).toMatchObject({ outcome: 'playing', frameMethod: 'playing_and_timeupdate' });
  });

  it('does not inherit the old videos playback position as the new fallback baseline', () => {
    video.requestVideoFrameCallback = undefined;
    video.currentTime = 90;
    bind();
    video.currentTime = 0.1;
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('timeupdate'));
    expect(reports[0]?.outcome).toBe('playing');
  });

  it('falls back when a WebView exposes the frame API but throws', () => {
    video.requestVideoFrameCallback = () => {
      throw new Error('not supported');
    };
    bind();
    video.dispatchEvent(new Event('playing'));
    video.currentTime = 0.2;
    video.dispatchEvent(new Event('timeupdate'));
    expect(reports[0]?.frameMethod).toBe('playing_and_timeupdate');
  });

  it('ignores callbacks from a different currentSrc and accepts only the new resource', () => {
    video.currentSrc = 'previous-media';
    bind();
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(reports).toHaveLength(0);
    video.currentSrc = 'media-a';
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(reports[0]?.outcome).toBe('playing');
  });

  it('disposes event listeners and invalidates queued old frame callbacks', () => {
    const observer = bind();
    const lateFrame = video.frame;
    observer.dispose();
    lateFrame?.();
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('error'));
    observer.rejected(new Error('late failure'));
    expect(reports).toHaveLength(0);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
  });

  it('records autoplay rejection separately and never emits a later false success', () => {
    const observer = bind();
    observer.rejected(new DOMException('user gesture required', 'NotAllowedError'));
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe('autoplay_blocked');
    expect(reports[0]?.media?.events).toEqual([
      expect.objectContaining({
        name: 'play_rejected',
        trigger: 'automatic',
        error: 'not_allowed',
      }),
    ]);
  });

  it('ignores release AbortError and records real media errors', () => {
    const observer = bind();
    observer.rejected(new DOMException('released', 'AbortError'));
    expect(reports).toHaveLength(0);
    video.dispatchEvent(new Event('error'));
    expect(reports[0]?.outcome).toBe('error');
  });
});
