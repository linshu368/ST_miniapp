import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureCdnSeek } from './drama-cdn-seek';

class Video extends EventTarget {
  duration = 100;
  currentTime = 0;
  seeking = false;
  readyState = 4;
  paused = false;
  error = null;
  buffered = { length: 1, start: () => 0, end: () => 2 };
  play = vi.fn(async () => {});
  callbacks = new Map<number, VideoFrameRequestCallback>();
  next = 0;
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    this.callbacks.set(++this.next, callback);
    return this.next;
  }
  cancelVideoFrameCallback(id: number) {
    this.callbacks.delete(id);
  }
  frame(time: number) {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks)
      callback(performance.now(), { mediaTime: time } as VideoFrameCallbackMetadata);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('one bounded unbuffered seek', () => {
  it('retains pre-seek ranges and requires target frame plus subsequent advancement', () => {
    const video = new Video();
    const done = vi.fn();
    measureCdnSeek(video as unknown as HTMLVideoElement, done);
    expect(video.currentTime).toBe(72);
    video.frame(0);
    expect(done).not.toHaveBeenCalled();
    video.frame(72);
    expect(done).not.toHaveBeenCalled();
    video.frame(72.1);
    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'playing',
      target_seconds: 72,
      buffered: [[0, 2]],
      frame_method: 'video_frame_callback',
    });
  });
  it('records already buffered and unreadable targets without seeking or substituting', () => {
    const video = new Video();
    const done = vi.fn();
    video.buffered.end = () => 100;
    measureCdnSeek(video as unknown as HTMLVideoElement, done);
    expect(done.mock.calls[0]?.[0].outcome).toBe('buffered');
    expect(video.currentTime).toBe(0);
    video.buffered.end = () => {
      throw new Error('unreadable');
    };
    measureCdnSeek(video as unknown as HTMLVideoElement, done);
    expect(done.mock.calls[1]?.[0].outcome).toBe('unknown_buffer');
  });
  it('records timeout once and ignores late frames without retry', () => {
    const video = new Video();
    const done = vi.fn();
    measureCdnSeek(video as unknown as HTMLVideoElement, done);
    vi.advanceTimersByTime(15000);
    video.frame(72);
    video.frame(72.1);
    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0]?.[0].outcome).toBe('timeout');
    expect(video.play).toHaveBeenCalledOnce();
  });
  it('records interrupted cleanup and removes callbacks', () => {
    const video = new Video();
    const done = vi.fn();
    const stop = measureCdnSeek(video as unknown as HTMLVideoElement, done);
    stop();
    stop();
    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0]?.[0].outcome).toBe('interrupted');
    expect(video.callbacks.size).toBe(0);
  });
});
