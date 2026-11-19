import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DramaTimingReportSchema } from '@miniapp/shared';
import type { DramaPlayback } from '@miniapp/shared';
import { loadDramaSource } from '../drama-media-source';
import type { DramaTimingReport } from './drama-timing';
import { observeSeekResources } from './drama-resources';
import { observeDramaSeek } from './drama-seek';
import { recordHlsLoads, type HlsEvents } from './drama-hls';

const ORIGIN = 'https://customer-abc123.cloudflarestream.com';
const SOURCE = `${ORIGIN}/SIGNED.TOKEN/manifest/video.m3u8`;

type Handler = (event: string, data: unknown) => void;
class FakeHls {
  static Events = {
    MANIFEST_LOADED: 'manifest',
    LEVEL_LOADED: 'level',
    AUDIO_TRACK_LOADED: 'audio',
    FRAG_LOADED: 'frag',
    FRAG_BUFFERED: 'buffered',
    FRAG_LOADING: 'loading',
    FRAG_LOAD_EMERGENCY_ABORTED: 'aborted',
    LEVEL_SWITCHING: 'switching',
    ERROR: 'error',
    MEDIA_ATTACHED: 'attached',
  };
  static isSupported = () => true;
  levels = [{ bitrate: 400_000, height: 240 }];
  handlers = new Map<string, Set<Handler>>();
  on(name: string, handler: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
  }
  off(name: string, handler: Handler) {
    this.handlers.get(name)?.delete(handler);
  }
  emit(name: string, data: unknown) {
    for (const handler of this.handlers.get(name) ?? []) handler(name, data);
  }
  loadSource = vi.fn();
  attachMedia = vi.fn();
  destroy = vi.fn();
}
vi.mock('hls.js', () => ({ default: FakeHls }));

describe('observeSeekResources', () => {
  type Listener = (list: { getEntries(): PerformanceEntry[] }) => void;
  let listener: Listener | undefined;
  beforeEach(() => {
    listener = undefined;
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['resource'];
        constructor(cb: Listener) {
          listener = cb;
        }
        observe() {}
        takeRecords() {
          return [];
        }
        disconnect() {}
      }
    );
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const resource = (name: string, startTime: number, responseEnd: number) =>
    ({
      name,
      startTime,
      fetchStart: startTime,
      responseEnd,
      duration: responseEnd - startTime,
      entryType: 'resource',
      requestStart: 0,
      responseStart: 0,
    }) as PerformanceResourceTiming;

  it('matches Stream sub-requests by signed prefix, classifies kind and reports no URL', () => {
    const reader = observeSeekResources(SOURCE, 100, 20, vi.fn());
    listener?.({
      getEntries: () => [
        resource(SOURCE, 90, 150),
        resource(`${ORIGIN}/SIGNED.TOKEN/manifest/stream_t1.m3u8?a=1`, 110, 160),
        resource(`${ORIGIN}/SIGNED.TOKEN/video/seg_3.m4s`, 120, 300),
        // 与分片同起止、不同请求（视频/音频并行）不能被去重吃掉。
        resource(`${ORIGIN}/SIGNED.TOKEN/audio/seg_3.m4s`, 120, 300),
        // 仅前缀相似的域名、其他域名都不是 Stream 请求。
        resource('https://customer-abc123.cloudflarestream.com.evil.invalid/x.m3u8', 130, 200),
        resource('https://other.invalid/poster.jpg', 130, 200),
        // 快进开始前就已结束的请求不属于这次快进。
        resource(`${ORIGIN}/SIGNED.TOKEN/video/seg_1.m4s`, 30, 80),
      ],
    });
    const snapshot = reader.snapshot();
    expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
      'manifest',
      'playlist',
      'segment',
      'segment',
    ]);
    expect(snapshot.entries[0]).toMatchObject({ startMs: -10, responseEndMs: 50 });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('SIGNED');
    expect(serialized).not.toContain('cloudflarestream');
    reader.release();
  });

  it('keeps exact-URL matching for non-Stream sources and attaches no kind', () => {
    const reader = observeSeekResources('https://cdn.invalid/a.mp4', 100, 20, vi.fn());
    listener?.({
      getEntries: () => [
        resource('https://cdn.invalid/a.mp4', 110, 200),
        resource('https://cdn.invalid/b.mp4', 110, 200),
      ],
    });
    const { entries } = reader.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('kind');
    reader.release();
  });
});

describe('hls.js seek diagnostics', () => {
  class Video extends EventTarget {
    // hls.js 走 MSE：currentSrc 是 blob 地址，不等于 play_url。
    currentSrc = 'blob:https://app.invalid/1234';
    src = '';
    currentTime = 0;
    readyState = 2;
    paused = false;
    seeking = false;
    buffered = { length: 1, start: () => 0, end: () => 3 };
    canPlayType = () => '';
    frame?: VideoFrameRequestCallback;
    requestVideoFrameCallback = (callback: VideoFrameRequestCallback) => {
      this.frame = callback;
      return 1;
    };
    cancelVideoFrameCallback = vi.fn();
  }
  let reports: DramaTimingReport[];
  beforeEach(() => {
    reports = [];
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const stats = (start: number, first: number, end: number, total: number) => ({
    loading: { start, first, end },
    buffering: { start: 0, first: 0, end: 0 },
    total,
    loaded: total,
  });
  const frag = (sn: number, type: string, start: number, loading: ReturnType<typeof stats>) => ({
    sn,
    type,
    level: 0,
    start,
    duration: 4,
    stats: loading,
  });

  const loadHls = async (video: Video) => {
    let handle: { player: never; events: HlsEvents } | undefined;
    loadDramaSource(
      video as unknown as HTMLVideoElement,
      { play_url: SOURCE, format: 'hls', playable: true } as DramaPlayback,
      () => {},
      () => {},
      (hls, events) => {
        handle = { player: hls as never, events };
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handle).toBeDefined();
    return { handle: handle!, fake: handle!.player as unknown as FakeHls };
  };

  it('keeps observing through a blob source and marks the fragment covering the target', async () => {
    const video = new Video();
    const { handle, fake } = await loadHls(video);
    // 播放器自身（快进重启加载）在整个播放期间订阅分片事件；这里只校验诊断自己的订阅。
    const hlsEventNames = ['manifest', 'level', 'audio', 'frag', 'buffered'];
    const playerHandlers = hlsEventNames.map((name) => fake.handlers.get(name)?.size ?? 0);

    const target = 10; // 秒：落在 start=8、时长 4 的分片里
    const stop = observeDramaSeek(video as unknown as HTMLVideoElement, SOURCE, target, true, {
      id: 'seek-id',
      dramaId: 'a',
      hls: handle,
      engine: 'hlsjs_mse',
      now: () => performance.now(),
      emit: (report) => reports.push(report),
    });
    const at = performance.now();
    await vi.advanceTimersByTimeAsync(100);
    video.currentTime = target;
    video.seeking = true;
    video.dispatchEvent(new Event('seeking'));

    // 目标之前的分片、覆盖目标的视频/音频分片、紧邻的下一片、init 段。
    fake.emit('frag', {
      frag: frag(1, 'main', 4, stats(at + 20, at + 120, at + 200, 50_000)),
    });
    fake.emit('frag', {
      frag: frag(2, 'main', 8, stats(at + 210, at + 700, at + 1500, 83_000)),
    });
    fake.emit('frag', {
      frag: frag(2, 'audio', 8, stats(at + 215, at + 400, at + 500, 9_000)),
    });
    fake.emit('frag', {
      frag: frag(3, 'main', 12, stats(at + 1510, at + 1600, at + 1700, 83_000)),
    });
    fake.emit('frag', {
      frag: { ...frag(0, 'main', 0, stats(at + 5, at + 50, at + 90, 700)), sn: 'initSegment' },
    });

    await vi.advanceTimersByTimeAsync(1600);
    video.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    video.dispatchEvent(new Event('playing'));
    video.frame?.(0, { mediaTime: target, processingDuration: 0 } as VideoFrameCallbackMetadata);

    const final = reports.find((report) => report.phase === 'final')!;
    // 旧实现里 blob 源会让观测在首次轮询时以 switched 结束。
    expect(final.outcome).toBe('playing');
    expect(final.engine).toBe('hlsjs_mse');
    const entries = final.diagnostics!.hls!.entries;
    expect(entries.filter((entry) => entry.coversTarget)).toEqual([
      expect.objectContaining({ kind: 'fragment', track: 'main', sn: 2, level: 0 }),
      expect.objectContaining({ kind: 'fragment', track: 'audio', sn: 2 }),
    ]);
    // 起止、首字节、字节数、档位都在，且都相对快进开始时刻。
    expect(entries.find((entry) => entry.coversTarget && entry.track === 'main')).toMatchObject({
      startMs: 210,
      firstByteMs: 700,
      endMs: 1500,
      bytes: 83_000,
      bitrate: 400_000,
      height: 240,
      positionMs: 8000,
      mediaMs: 4000,
    });
    expect(entries.find((entry) => entry.kind === 'init')).not.toHaveProperty('coversTarget');
    expect(entries.find((entry) => entry.sn === 3)).not.toHaveProperty('coversTarget');
    expect(entries.find((entry) => entry.sn === 1)).not.toHaveProperty('coversTarget');

    expect(DramaTimingReportSchema.safeParse(final).success).toBe(true);
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain('SIGNED');
    expect(serialized).not.toContain('cloudflarestream');

    // 终态后不再订阅，迟到的分片事件不会改动已发出的报告。
    stop();
    expect(hlsEventNames.map((name) => fake.handlers.get(name)?.size ?? 0)).toEqual(playerHandlers);
  });

  it('does not touch hls diagnostics for non-hls sources', async () => {
    const video = new Video();
    video.currentSrc = 'media-a';
    const stop = observeDramaSeek(video as unknown as HTMLVideoElement, 'media-a', 10, true, {
      id: 'seek-id',
      dramaId: 'a',
      now: () => performance.now(),
      emit: (report) => reports.push(report),
    });
    stop('left');
    expect(reports.at(-1)?.diagnostics).not.toHaveProperty('hls');
  });

  it('records hls.js load process events within the seek window, capped with counts', async () => {
    const video = new Video();
    const { handle, fake } = await loadHls(video);
    const names = ['loading', 'aborted', 'switching', 'error'];
    const playerHandlers = names.map((name) => fake.handlers.get(name)?.size ?? 0);
    const stop = observeDramaSeek(video as unknown as HTMLVideoElement, SOURCE, 10, true, {
      id: 'seek-id',
      dramaId: 'a',
      hls: handle,
      engine: 'hlsjs_mse',
      now: () => performance.now(),
      emit: (report) => reports.push(report),
    });
    const loading = (sn: number | string, type = 'main', level = 2) => ({
      frag: { sn, type, level, start: 8, duration: 4 },
    });
    await vi.advanceTimersByTimeAsync(100);
    fake.emit('loading', loading(2));
    fake.emit('loading', loading('initSegment'));
    fake.emit('loading', loading(2, 'audio', 0));
    fake.emit('aborted', loading(2));
    fake.emit('switching', { level: 0 });
    fake.emit('error', { details: 'fragLoadError', fatal: false, ...loading(2) });
    // 不是标识符的 detail 不进报告，其余字段照记。
    fake.emit('error', { details: 'https://x.invalid/seg.m4s', fatal: false });
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 30; i++) fake.emit('loading', loading(2, 'main', i % 2));

    stop('left');
    const final = reports.find((report) => report.phase === 'final')!;
    const hls = final.diagnostics!.hls!;
    expect(hls.events!.slice(0, 7)).toEqual([
      { atMs: 100, type: 'frag_loading', track: 'main', sn: 2, level: 2 },
      { atMs: 100, type: 'frag_loading', track: 'main', level: 2 },
      { atMs: 100, type: 'frag_loading', track: 'audio', sn: 2 },
      { atMs: 100, type: 'frag_emergency_aborted', track: 'main', sn: 2, level: 2 },
      { atMs: 100, type: 'level_switching', level: 0 },
      {
        atMs: 100,
        type: 'error',
        track: 'main',
        sn: 2,
        level: 2,
        detail: 'fragLoadError',
        fatal: false,
      },
      { atMs: 100, type: 'error', fatal: false },
    ]);
    // 最早 12 条之后保留的是最近 12 条（循环里第 18–29 次），中间的只计数。
    expect(hls.events).toHaveLength(24);
    expect(hls.events!.slice(12)).toEqual(
      Array.from({ length: 12 }, (_, i) => ({
        atMs: 200,
        type: 'frag_loading',
        track: 'main',
        sn: 2,
        level: (18 + i) % 2,
      }))
    );
    expect(hls.eventsTruncated).toBe(true);
    expect(hls.eventCounts).toEqual({
      fragLoading: 33,
      emergencyAborted: 1,
      levelSwitching: 1,
      error: 2,
    });
    expect(hls.entries).toEqual([]);
    expect(DramaTimingReportSchema.safeParse(final).success).toBe(true);
    expect(JSON.stringify(reports)).not.toContain('invalid');

    // 终态后退订，迟到的事件不再记录。
    expect(names.map((name) => fake.handlers.get(name)?.size ?? 0)).toEqual(playerHandlers);
    const emitted = reports.length;
    fake.emit('loading', loading(3));
    expect(reports).toHaveLength(emitted);
  });

  it('startup hls diagnostics never carry load process events', () => {
    const fake = new FakeHls();
    const snapshots: unknown[] = [];
    const stop = recordHlsLoads(
      fake as never,
      FakeHls.Events as unknown as HlsEvents,
      performance.now(),
      (snapshot) => snapshots.push(snapshot)
    );
    fake.emit('loading', { frag: { sn: 1, type: 'main', level: 0 } });
    fake.emit('manifest', { stats: stats(1, 2, 3, 100) });
    stop();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).not.toHaveProperty('events');
    expect(snapshots[0]).not.toHaveProperty('eventCounts');
  });

  describe('resume verification when frame callbacks never qualify', () => {
    const target = 10;
    const start = () => {
      const video = new Video();
      video.currentSrc = 'media-a';
      const stop = observeDramaSeek(video as unknown as HTMLVideoElement, 'media-a', target, true, {
        id: 'seek-id',
        dramaId: 'a',
        now: () => performance.now(),
        emit: (report) => reports.push(report),
      });
      video.currentTime = target;
      video.dispatchEvent(new Event('seeking'));
      video.dispatchEvent(new Event('seeked'));
      video.dispatchEvent(new Event('playing'));
      const tick = (currentTime: number) => {
        video.currentTime = currentTime;
        video.dispatchEvent(new Event('timeupdate'));
      };
      const final = () => reports.find((report) => report.phase === 'final');
      return { video, stop, tick, final };
    };

    it('falls back to timeupdate progress when every frame is rejected', async () => {
      const { video, tick, final } = start();
      // 线上 iOS：帧回调触发了，但 mediaTime 与 currentTime 差超过 1s，被判为不合格。
      video.frame?.(0, { mediaTime: target + 5 } as VideoFrameCallbackMetadata);
      await vi.advanceTimersByTimeAsync(250);
      tick(target + 0.3);
      expect(final()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      tick(target + 0.55);
      expect(final()).toMatchObject({ outcome: 'playing', frameMethod: 'playing_and_timeupdate' });
      expect(final()!.seek!.frameMs).toBe(500);
    });

    it('keeps the frame callback result when frames qualify', () => {
      const { video, final } = start();
      video.frame?.(0, { mediaTime: target } as VideoFrameCallbackMetadata);
      expect(final()).toMatchObject({ outcome: 'playing', frameMethod: 'video_frame_callback' });
    });

    it('still ends as paused when playback stops after a single progress tick', () => {
      const { video, tick, final } = start();
      tick(target + 0.3);
      video.paused = true;
      video.dispatchEvent(new Event('pause'));
      expect(final()).toMatchObject({ outcome: 'unverified' });
      expect(final()!.seek!.endReason).toBe('paused');
    });

    it('restarts the progress evidence after another seek', () => {
      const { video, stop, tick, final } = start();
      tick(target + 0.3);
      video.dispatchEvent(new Event('seeking'));
      tick(target + 0.6);
      expect(final()).toBeUndefined();
      stop('left');
    });
  });
});
