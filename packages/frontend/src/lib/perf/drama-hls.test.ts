import { beforeEach, describe, expect, it, vi } from 'vitest';
import type HlsPlayer from 'hls.js';
import { DRAMA_TIMING_MAX_RESOURCES, DramaTimingReportSchema } from '@miniapp/shared';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';
import { observeDramaHls, recordHlsLoads, type HlsEvents } from './drama-hls';

const events = {
  MANIFEST_LOADED: 'manifest',
  LEVEL_LOADED: 'level',
  AUDIO_TRACK_LOADED: 'audio',
  FRAG_LOADED: 'frag',
  FRAG_BUFFERED: 'buffered',
} as unknown as HlsEvents;

type Handler = (event: string, data: unknown) => void;
class FakeHls {
  levels = [{ bitrate: 400_000.4, height: 240 }];
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
}

const stats = (start: number, first: number, end: number, total = 0) => ({
  loading: { start, first, end },
  buffering: { start: 0, first: 0, end: 0 },
  total,
  loaded: total,
});
const SECRET = 'https://customer-abc.cloudflarestream.com/SIGNED/video.m3u8';
const fragment = (sn: number | 'initSegment', type: string, extra: object = {}) => ({
  sn,
  type,
  level: 0,
  start: 4,
  duration: 4,
  url: SECRET,
  stats: stats(140, 400, 520, 83_000),
  ...extra,
});

let hls: FakeHls;
beforeEach(() => {
  hls = new FakeHls();
});

describe('hls.js load recorder', () => {
  it('maps loader stats to startup offsets without zero placeholders or URLs', () => {
    const snapshots: unknown[] = [];
    recordHlsLoads(hls as unknown as HlsPlayer, events, 100, (s) => snapshots.push(s));
    hls.emit('manifest', { url: SECRET, stats: stats(100, 0, 300) });
    hls.emit('level', { level: 0, stats: stats(310, 380, 400, 900) });
    hls.emit('audio', { stats: stats(305, 370, 395) });
    const init = fragment('initSegment', 'main');
    const media = fragment(1, 'main');
    hls.emit('frag', { frag: init });
    hls.emit('frag', { frag: media });
    hls.emit('frag', { frag: fragment(1, 'audio') });
    hls.emit('frag', { frag: fragment(1, 'subtitle') });
    hls.emit('buffered', { frag: media, stats: { ...media.stats, buffering: { end: 560 } } });
    const last = snapshots.at(-1) as { entries: Record<string, unknown>[]; truncated: boolean };
    expect(last.truncated).toBe(false);
    expect(last.entries).toEqual([
      { kind: 'manifest', startMs: 0, endMs: 200 },
      {
        kind: 'level',
        track: 'main',
        level: 0,
        bitrate: 400_000,
        height: 240,
        startMs: 210,
        firstByteMs: 280,
        endMs: 300,
        bytes: 900,
      },
      { kind: 'audio_track', track: 'audio', startMs: 205, firstByteMs: 270, endMs: 295 },
      expect.objectContaining({ kind: 'init', track: 'main', level: 0 }),
      expect.objectContaining({
        kind: 'fragment',
        track: 'main',
        sn: 1,
        positionMs: 4000,
        mediaMs: 4000,
        startMs: 40,
        firstByteMs: 300,
        endMs: 420,
        appendedMs: 460,
        bytes: 83_000,
      }),
      expect.not.objectContaining({ level: expect.anything() }),
    ]);
    expect(last.entries[3]).not.toHaveProperty('positionMs');
    expect(last.entries[5]).toMatchObject({ kind: 'fragment', track: 'audio' });
    expect(JSON.stringify(snapshots)).not.toContain('SIGNED');
  });

  it('caps entries and marks truncation', () => {
    let last: { entries: unknown[]; truncated: boolean } | undefined;
    recordHlsLoads(hls as unknown as HlsPlayer, events, 0, (s) => (last = s));
    for (let sn = 0; sn < DRAMA_TIMING_MAX_RESOURCES + 3; sn += 1)
      hls.emit('frag', { frag: fragment(sn, 'main') });
    expect(last?.entries).toHaveLength(DRAMA_TIMING_MAX_RESOURCES);
    expect(last?.truncated).toBe(true);
  });

  it('stops at the startup terminal and survives malformed events', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const reports: DramaTimingReport[] = [];
    const tracker = new DramaTimingTracker(
      () => performance.now(),
      () => 'id',
      (report) => reports.push(report)
    );
    const flow = tracker.beginPlayback('a', 'cover');
    flow.mark('source_set');
    observeDramaHls(hls as unknown as HlsPlayer, events, flow);
    const at = flow.startedAt;
    hls.emit('manifest', { stats: undefined });
    hls.emit('manifest', { stats: stats(at + 1, at + 50, at + 60) });
    flow.finish('playing');
    hls.emit('frag', { frag: fragment(1, 'main') });
    const final = reports.find((r) => r.phase === 'final')!;
    expect(final.diagnostics?.hls?.entries).toEqual([
      { kind: 'manifest', startMs: 1, firstByteMs: 50, endMs: 60 },
    ]);
    expect(DramaTimingReportSchema.safeParse(final).success).toBe(true);
    expect([...hls.handlers.values()].every((set) => set.size === 0)).toBe(true);
    vi.useRealTimers();
  });
});
