import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';
import { observeDramaMedia } from './drama-media';
import { DRAMA_TIMING_MAX_MEDIA_EVENTS, DramaTimingReportSchema } from '@miniapp/shared';
import { mediaResourceFields, observeDramaResources } from './drama-resources';
import { observeDramaSeek } from './drama-seek';

const engineering = vi.hoisted(() => ({
  measurement: vi.fn(),
  event: vi.fn(),
  enabled: vi.fn(() => false),
  dimensions: { net_type: '4g', tg_platform: 'ios' },
}));
vi.mock('./grafana', () => ({
  isEngineeringTelemetryEnabled: engineering.enabled,
  recordEngineeringMeasurement: engineering.measurement,
  recordEngineeringEvent: engineering.event,
}));
vi.mock('./env-tags', () => ({
  getMetricDimensions: () => ({ ...engineering.dimensions }),
}));

class Video extends EventTarget {
  currentSrc = 'media-a';
  currentTime = 0;
  readyState = 2;
  networkState = 2;
  paused = true;
  muted = false;
  seeking = false;
  ended = false;
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
  vi.clearAllMocks();
  engineering.enabled.mockReturnValue(false);
  engineering.dimensions = { net_type: '4g', tg_platform: 'ios' };
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

describe('foreground playback quality windows', () => {
  beforeEach(() => {
    engineering.enabled.mockReturnValue(true);
    vi.stubGlobal(
      'document',
      Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false })
    );
  });
  const start = () => {
    const observer = bind();
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    return observer;
  };
  const windows = () =>
    engineering.event.mock.calls
      .filter(([name]) => name === 'drama.playback_window')
      .map(([, attributes]) => attributes as Record<string, unknown>);

  it('pairs playback and buffering wall time in one weighted window, excluding startup', async () => {
    const observer = bind();
    video.paused = false;
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(5000);
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    await vi.advanceTimersByTimeAsync(10_000);
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(2000);
    video.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(8000);
    observer.dispose();
    expect(windows()).toEqual([
      expect.objectContaining({
        playing_ms: 18_000,
        rebuffer_ms: 2000,
        route: '/dramas/:id',
        stage: 'playback',
        source_measurement_version: 'drama_playback_v1',
        net_type: '4g',
        tg_platform: 'ios',
      }),
    ]);
  });

  it('reports thirty-second deltas and only the remaining tail once', async () => {
    const observer = start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(5000);
    observer.dispose();
    observer.dispose();
    video.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(windows().map(({ playing_ms, rebuffer_ms }) => [playing_ms, rebuffer_ms])).toEqual([
      [30_000, 0],
      [5000, 0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports long ongoing buffering in bounded, non-duplicated windows', async () => {
    const observer = start();
    await vi.advanceTimersByTimeAsync(1000);
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(64_000);
    observer.dispose();
    expect(windows().map(({ playing_ms, rebuffer_ms }) => [playing_ms, rebuffer_ms])).toEqual([
      [1000, 29_000],
      [0, 30_000],
      [0, 5000],
    ]);
  });

  it.each(['pause', 'seeking', 'background'] as const)(
    'excludes the long %s gap and resumes only with new playback evidence',
    async (boundary) => {
      const observer = start();
      await vi.advanceTimersByTimeAsync(1000);
      video.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(500);
      if (boundary === 'background') {
        Object.assign(document, { visibilityState: 'hidden', hidden: true });
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        video.paused = boundary === 'pause';
        video.seeking = boundary === 'seeking';
        video.dispatchEvent(new Event(boundary));
      }
      await vi.advanceTimersByTimeAsync(120_000);
      Object.assign(document, { visibilityState: 'visible', hidden: false });
      video.paused = false;
      video.seeking = false;
      video.currentTime = 1000;
      video.dispatchEvent(new Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(1000);
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(2000);
      observer.dispose();
      expect(windows().map(({ playing_ms, rebuffer_ms }) => [playing_ms, rebuffer_ms])).toEqual([
        [1000, 500],
        [2000, 0],
      ]);
    }
  );

  it('does not count network-only stalled events as buffering or fast-forwarded media as time', async () => {
    const observer = start();
    await vi.advanceTimersByTimeAsync(1000);
    video.dispatchEvent(new Event('stalled'));
    video.seeking = true;
    video.dispatchEvent(new Event('seeking'));
    video.currentTime = 1000;
    video.dispatchEvent(new Event('timeupdate'));
    video.seeking = false;
    video.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(1000);
    observer.dispose();
    expect(windows().map(({ playing_ms, rebuffer_ms }) => [playing_ms, rebuffer_ms])).toEqual([
      [1000, 0],
      [1000, 0],
    ]);
  });

  it('counts manual playback after autoplay refusal without rewriting the startup terminal', async () => {
    const observer = bind();
    const error = new Error('blocked');
    error.name = 'NotAllowedError';
    observer.rejected(error);
    expect(tracker.ensurePlayback('a').outcome).toBe('autoplay_blocked');
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(2000);
    observer.dispose();
    expect(windows()).toEqual([expect.objectContaining({ playing_ms: 2000, rebuffer_ms: 0 })]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe('autoplay_blocked');
  });

  it('does not let a late timeupdate turn a known wait into recovered playback', async () => {
    const observer = start();
    await vi.advanceTimersByTimeAsync(1000);
    video.dispatchEvent(new Event('waiting'));
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(2000);
    observer.dispose();
    expect(windows()).toEqual([expect.objectContaining({ playing_ms: 1000, rebuffer_ms: 2000 })]);
  });

  it('does not let the first delayed frame callback recover an already confirmed wait', async () => {
    const observer = bind();
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(1000);
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(1000);
    video.frame?.();
    await vi.advanceTimersByTimeAsync(2000);
    observer.dispose();
    expect(windows()).toEqual([expect.objectContaining({ playing_ms: 1000, rebuffer_ms: 3000 })]);
  });

  it('requires new playing after an early wait, even if frame and progress arrive later', async () => {
    const observer = bind();
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(1000);
    video.frame?.();
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(windows()).toHaveLength(0);
    video.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(2000);
    observer.dispose();
    expect(windows()).toEqual([expect.objectContaining({ playing_ms: 2000, rebuffer_ms: 0 })]);
  });

  it.each(['paused', 'hidden'] as const)(
    'drops an unconfirmed tail when the heartbeat finds a missed %s transition',
    async (missingEvent) => {
      const observer = start();
      await vi.advanceTimersByTimeAsync(1000);
      video.dispatchEvent(new Event('waiting'));
      if (missingEvent === 'paused') video.paused = true;
      else Object.assign(document, { visibilityState: 'hidden', hidden: true });
      await vi.advanceTimersByTimeAsync(29_000);
      observer.dispose();
      expect(windows()).toEqual([expect.objectContaining({ playing_ms: 1000, rebuffer_ms: 0 })]);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('marks a window mixed when its observed endpoint networks differ', async () => {
    const observer = start();
    await vi.advanceTimersByTimeAsync(1000);
    engineering.dimensions.net_type = '3g';
    observer.dispose();
    expect(windows()).toEqual([
      expect.objectContaining({ playing_ms: 1000, rebuffer_ms: 0, net_type: 'mixed' }),
    ]);
  });

  it('uses the existing home owner without sending drama or video identity', async () => {
    const timing = tracker.beginPlayback('a', 'switch', undefined, undefined, 'home');
    const observer = observeDramaMedia(video as unknown as HTMLVideoElement, 'media-a', timing);
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    await vi.advanceTimersByTimeAsync(1000);
    observer.dispose();
    expect(windows()).toEqual([expect.objectContaining({ route: '/', playing_ms: 1000 })]);
    expect(Object.keys(windows()[0] ?? {})).not.toEqual(
      expect.arrayContaining(['dramaId', 'videoId', 'sessionId', 'source'])
    );
  });

  it('discards an unobserved event-loop gap longer than sixty seconds', () => {
    const observer = start();
    vi.spyOn(performance, 'now').mockReturnValue(120_001);
    observer.dispose();
    expect(windows()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  });

  it('also discards an oversized whole window made of individually trusted intervals', () => {
    const observer = start();
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(40_000);
    video.dispatchEvent(new Event('waiting'));
    clock.mockReturnValue(80_000);
    video.dispatchEvent(new Event('playing'));
    observer.dispose();
    expect(windows()).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('flushes once on pagehide without requiring a preceding visibilitychange', async () => {
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    const observer = start();
    await vi.advanceTimersByTimeAsync(1000);
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(1000);
    page.dispatchEvent(new Event('pagehide'));
    page.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(60_000);
    observer.dispose();
    expect(windows().map(({ playing_ms, rebuffer_ms }) => [playing_ms, rebuffer_ms])).toEqual([
      [1000, 1000],
    ]);
  });

  it.each(['ended', 'error'] as const)(
    'preserves buffering before %s without counting after it',
    async (end) => {
      const observer = start();
      await vi.advanceTimersByTimeAsync(1000);
      video.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(1000);
      video.dispatchEvent(new Event(end));
      await vi.advanceTimersByTimeAsync(60_000);
      observer.dispose();
      expect(windows().map(({ playing_ms, rebuffer_ms }) => [playing_ms, rebuffer_ms])).toEqual([
        [1000, 1000],
      ]);
    }
  );

  it('does not accept later progress from a replacement source into the old observer', async () => {
    const observer = start();
    await vi.advanceTimersByTimeAsync(1000);
    video.currentSrc = 'media-b';
    video.currentTime = 10;
    video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(60_000);
    video.dispatchEvent(new Event('playing'));
    observer.dispose();
    expect(windows().map(({ playing_ms, rebuffer_ms }) => [playing_ms, rebuffer_ms])).toEqual([
      [1000, 0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates exporter failure and still releases every quality timer', async () => {
    const observer = start();
    await vi.advanceTimersByTimeAsync(1000);
    engineering.event.mockImplementationOnce(() => {
      throw new Error('queue unavailable');
    });
    expect(() => observer.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(video.paused).toBe(false);
  });

  it('does not create playback windows or a quality heartbeat while telemetry is disabled', async () => {
    engineering.enabled.mockReturnValue(false);
    const observer = start();
    await vi.advanceTimersByTimeAsync(90_000);
    observer.dispose();
    expect(windows()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('video startup observation', () => {
  it('keeps an unbuffered seek waiting after seeked and rejects old frames before the target frame', async () => {
    const media = video as unknown as HTMLVideoElement;
    let callback: VideoFrameRequestCallback | undefined;
    media.requestVideoFrameCallback = (listener) => {
      callback = listener;
      return 1;
    };
    const stop = observeDramaSeek(media, 'media-a', 40, true, {
      id: 'seek-id',
      dramaId: 'a',
      now: () => performance.now(),
      emit: (report) => reports.push(report),
    });
    video.currentTime = 40;
    await vi.advanceTimersByTimeAsync(300);
    video.dispatchEvent(new Event('seeked'));
    expect(reports).toHaveLength(0);
    const frame = (mediaTime: number): VideoFrameCallbackMetadata => ({
      mediaTime,
      expectedDisplayTime: 0,
      presentationTime: 0,
      presentedFrames: 1,
      processingDuration: 0,
      width: 320,
      height: 240,
    });
    callback?.(performance.now(), frame(0));
    expect(reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(reports.at(-1)).toMatchObject({
      phase: 'slow',
      outcome: 'waiting',
      seek: { buffered: 'no' },
    });
    callback?.(performance.now(), frame(40));
    expect(reports.at(-1)).toMatchObject({
      phase: 'final',
      outcome: 'playing',
      elapsedMs: 6300,
      seek: { seekedMs: 300, frameMs: 6300 },
    });
    const count = reports.length;
    stop();
    callback?.(performance.now(), frame(40));
    expect(reports).toHaveLength(count);
    expect(DramaTimingReportSchema.safeParse(reports.at(-1)).success).toBe(true);
  });
  it('keeps invalid TimeRanges unknown and tolerates native frame cancellation failure', () => {
    video.buffered.start = () => NaN;
    video.cancelVideoFrameCallback.mockImplementation(() => {
      throw new Error('native cleanup');
    });
    const stop = observeDramaSeek(video as unknown as HTMLVideoElement, 'media-a', 40, true, {
      id: 'seek-id',
      dramaId: 'a',
      now: () => performance.now(),
      emit: (report) => reports.push(report),
    });
    expect(() => stop('left')).not.toThrow();
    expect(reports.at(-1)).toMatchObject({ outcome: 'left', seek: { buffered: 'unknown' } });
  });
  it('records a paused seek without frame support as unverified and keeps aborted seeks terminal', async () => {
    video.requestVideoFrameCallback = undefined;
    const stop = observeDramaSeek(video as unknown as HTMLVideoElement, 'media-a', 40, false, {
      id: 'seek-id',
      dramaId: 'a',
      now: () => performance.now(),
      emit: (report) => reports.push(report),
    });
    await vi.advanceTimersByTimeAsync(600);
    video.dispatchEvent(new Event('seeked'));
    expect(reports.at(-1)).toMatchObject({ outcome: 'unverified', elapsedMs: 600 });
    stop('left');
    video.dispatchEvent(new Event('error'));
    expect(reports).toHaveLength(1);
  });
  it('does not call a network-only stalled event a user-visible playback interruption', async () => {
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const observer = bind();
    video.paused = false;
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    video.readyState = 4;
    video.dispatchEvent(new Event('stalled'));
    await vi.advanceTimersByTimeAsync(2000);
    video.currentTime = 2;
    video.dispatchEvent(new Event('timeupdate'));
    observer.dispose();
    expect(engineering.measurement).not.toHaveBeenCalled();
    expect(engineering.event).not.toHaveBeenCalled();
  });

  it('measures one foreground post-startup rebuffer without changing the startup terminal', async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false });
    vi.stubGlobal('document', page);
    const observer = bind();
    video.paused = false;
    video.dispatchEvent(new Event('waiting')); // Initial load is not rebuffering.
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(engineering.measurement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(500);
    video.dispatchEvent(new Event('stalled'));
    await vi.advanceTimersByTimeAsync(1000);
    video.dispatchEvent(new Event('playing'));
    expect(engineering.measurement).toHaveBeenCalledExactlyOnceWith(
      'drama.rebuffer',
      1500,
      expect.objectContaining({ outcome: 'playing', stage: 'rebuffer' })
    );
    expect(engineering.event.mock.calls.map(([, attrs]) => attrs.outcome)).toEqual([
      'waiting',
      'playing',
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe('playing');
    observer.dispose();
    video.dispatchEvent(new Event('waiting'));
    expect(engineering.event).toHaveBeenCalledTimes(2);
  });

  it('excludes paused, seeking and background waits; background cancels a foreground interval once', async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false });
    vi.stubGlobal('document', page);
    const observer = bind();
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    video.dispatchEvent(new Event('waiting')); // paused
    video.paused = false;
    video.seeking = true;
    video.dispatchEvent(new Event('waiting'));
    video.seeking = false;
    page.visibilityState = 'hidden';
    video.dispatchEvent(new Event('waiting'));
    expect(engineering.event).not.toHaveBeenCalled();
    page.visibilityState = 'visible';
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(700);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10000);
    page.visibilityState = 'visible';
    video.dispatchEvent(new Event('playing'));
    expect(engineering.measurement).toHaveBeenCalledExactlyOnceWith(
      'drama.rebuffer',
      700,
      expect.objectContaining({ outcome: 'background' })
    );
    observer.dispose();
  });

  it.each(['pause', 'seeking', 'ended', 'error', 'dispose', 'switch'] as const)(
    'does not classify an interval interrupted by %s as a completed rebuffer',
    async (end) => {
      vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
      const observer = bind();
      video.paused = false;
      video.dispatchEvent(new Event('playing'));
      video.frame?.();
      video.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(200);
      if (end === 'dispose') observer.dispose();
      else if (end === 'switch') {
        video.currentSrc = 'media-b';
        video.dispatchEvent(new Event('playing'));
      } else video.dispatchEvent(new Event(end));
      const outcome = {
        pause: 'paused',
        seeking: 'seek',
        ended: 'ended',
        error: 'error',
        dispose: 'disposed',
        switch: 'switched',
      }[end];
      expect(engineering.measurement).toHaveBeenCalledExactlyOnceWith(
        'drama.rebuffer',
        200,
        expect.objectContaining({ outcome })
      );
      observer.dispose();
    }
  );

  it('clips long-task evidence to the startup and metadata-to-frame windows', async () => {
    let callback: ((list: { getEntries(): PerformanceEntry[] }) => void) | undefined;
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['longtask'];
        constructor(listener: typeof callback) {
          callback = listener;
        }
        observe() {}
        takeRecords() {
          return [];
        }
        disconnect() {}
      }
    );
    const observer = bind();
    await vi.advanceTimersByTimeAsync(100);
    video.dispatchEvent(new Event('loadedmetadata'));
    await vi.advanceTimersByTimeAsync(200);
    callback?.({
      getEntries: () =>
        [
          { startTime: 90, duration: 60 },
          { startTime: 200, duration: 80 },
        ] as PerformanceEntry[],
    });
    video.dispatchEvent(new Event('playing'));
    video.frame?.();
    expect(reports[0]?.diagnostics?.longTasks).toEqual({
      support: 'supported',
      count: 2,
      totalMs: 140,
      maxMs: 80,
      metadataToFrameMs: 130,
      truncated: false,
    });
    observer.dispose();
  });
  it('keeps media cleanup and terminal reporting working when optional observers throw', () => {
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['resource', 'longtask'];
        observe() {}
        takeRecords(): PerformanceEntry[] {
          throw new Error('unavailable');
        }
        disconnect() {
          throw new Error('unavailable');
        }
      }
    );
    const observer = bind();
    expect(() => tracker.ensurePlayback('a').finish('error')).not.toThrow();
    expect(reports[0]?.outcome).toBe('error');
    expect(() => observer.dispose()).not.toThrow();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });
  it('captures first-frame metadata independently of playing, including a forty-second data wait', async () => {
    const observer = bind();
    video.dispatchEvent(new Event('loadedmetadata'));
    await vi.advanceTimersByTimeAsync(40_000);
    video.dispatchEvent(new Event('loadeddata'));
    // The fake video only needs to deliver the browser callback arguments here.
    const frame = video.frame as
      | ((at: number, metadata: Partial<VideoFrameCallbackMetadata>) => void)
      | undefined;
    frame?.(performance.now(), {
      processingDuration: 0.012,
      presentationTime: 39999,
      expectedDisplayTime: 40016,
      width: 1080,
      height: 1920,
    });
    expect(reports).toHaveLength(1); // slow snapshot; playing has not arrived.
    video.dispatchEvent(new Event('playing'));
    expect(reports[1]?.diagnostics?.frame).toMatchObject({
      processingMs: 12,
      width: 1080,
      height: 1920,
    });
    expect(reports[1]?.stages.metadata_to_frame).toBe(40000);
    observer.dispose();
  });

  it('keeps hidden cross-origin timing unknown and never serializes the signed resource name', () => {
    const limited = {
      name: 'https://private.invalid/video?token=secret',
      startTime: 100,
      fetchStart: 100,
      requestStart: 0,
      responseStart: 0,
      responseEnd: 7100,
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      connectEnd: 0,
      secureConnectionStart: 0,
      encodedBodySize: 0,
      transferSize: 0,
      nextHopProtocol: '',
    } as PerformanceResourceTiming;
    const fields = mediaResourceFields(limited, 100);
    expect(fields).toMatchObject({ startMs: 0, responseEndMs: 7000, visibility: 'limited' });
    expect(fields?.ttfbMs).toBeUndefined();
    expect(fields?.encodedBodyBytes).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain('secret');
    expect(
      mediaResourceFields(
        { ...limited, requestStart: 200, responseStart: 7000 } as PerformanceResourceTiming,
        100
      )?.ttfbMs
    ).toBe(6800);
  });

  it('isolates sources, freezes final snapshots and only supplements late network evidence once', async () => {
    type Listener = (list: { getEntries(): PerformanceEntry[] }) => void;
    let listener: Listener | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['resource'];
        constructor(callback: Listener) {
          listener = callback;
        }
        observe() {}
        disconnect = disconnect;
        takeRecords() {
          return [];
        }
      }
    );
    const v2 = new DramaTimingTracker(
      () => performance.now(),
      () => 'network-id',
      (r) => reports.push(r),
      { release: 'test', sessionId: 'test-session', platform: 'ios', browser: 'webkit' }
    );
    const flow = v2.beginPlayback('a', 'cover');
    flow.mark('source_set');
    const stop = observeDramaResources('https://media.invalid/a?token=private', flow);
    flow.finish('playing');
    const final = reports.find((r) => r.phase === 'final')!;
    const resource = (name: string, startTime = 1) =>
      ({
        entryType: 'resource',
        name,
        startTime,
        fetchStart: startTime,
        duration: 9,
        responseEnd: 10,
        requestStart: 2,
        responseStart: 5,
        domainLookupStart: 1,
        domainLookupEnd: 1,
        connectStart: 1,
        connectEnd: 2,
        secureConnectionStart: 0,
        encodedBodySize: 2,
        transferSize: 302,
        nextHopProtocol: 'h2',
      }) as PerformanceResourceTiming;
    listener?.({
      getEntries: () => [
        resource('https://media.invalid/poster'),
        resource('https://media.invalid/a?token=private', -1),
        resource('https://media.invalid/a?token=private'),
      ],
    });
    expect(final.diagnostics?.network?.entries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reports.map((r) => r.phase)).toEqual(['start', 'final', 'network']);
    expect(reports[2]?.diagnostics?.network?.entries).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain('private');
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
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
