import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DramaTimingReportSchema } from '@miniapp/shared';
import type { DramaPlayback } from '@miniapp/shared';
import { loadDramaSource } from '../drama-media-source';
import type { DramaTimingReport } from './drama-timing';
import { observeSeekResources } from './drama-resources';
import { observeDramaSeek } from './drama-seek';
import type { HlsEvents } from './drama-hls';

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

  it('keeps observing through a blob source and marks the fragment covering the target', async () => {
    const video = new Video();
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
    const fake = handle!.player as unknown as FakeHls;

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
    for (const name of ['manifest', 'level', 'audio', 'frag', 'buffered'])
      expect(fake.handlers.get(name)?.size ?? 0).toBe(0);
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
});
