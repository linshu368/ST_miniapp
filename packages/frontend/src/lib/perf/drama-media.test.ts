import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';
import { observeDramaMedia } from './drama-media';

class Video extends EventTarget {
  currentSrc = 'media-a';
  currentTime = 0;
  readyState = 2;
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
});

describe('video startup observation', () => {
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
  });

  it('ignores release AbortError and records real media errors', () => {
    const observer = bind();
    observer.rejected(new DOMException('released', 'AbortError'));
    expect(reports).toHaveLength(0);
    video.dispatchEvent(new Event('error'));
    expect(reports[0]?.outcome).toBe('error');
  });
});
