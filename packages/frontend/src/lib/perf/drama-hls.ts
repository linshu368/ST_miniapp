import type HlsPlayer from 'hls.js';
import type {
  AudioTrackLoadedData,
  Events,
  FragBufferedData,
  FragLoadedData,
  Fragment,
  LevelLoadedData,
  LoaderStats,
  ManifestLoadedData,
} from 'hls.js';
import {
  DRAMA_TIMING_MAX_RESOURCES,
  type DramaHlsLoad,
  type DramaStartupDiagnostics,
} from '@miniapp/shared';
import type { DramaPlaybackTiming } from './drama-timing';

export type HlsEvents = typeof Events;
export type HlsLoadSnapshot = NonNullable<DramaStartupDiagnostics['hls']>;

const round = (n: number) => Math.round(n * 10) / 10;
const positive = (n: number | undefined) =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;

/** 分片时间范围 [start, start+duration) 是否包含快进目标；主视频与音轨各标各的，init 段没有范围。 */
const coversTarget = (start: number, duration: number | undefined, target: number | undefined) =>
  target !== undefined &&
  duration !== undefined &&
  Number.isFinite(start) &&
  start <= target &&
  target < start + duration;

/**
 * 被动记录 hls.js 自带的加载统计（performance.now 时钟，与起播计时同源），
 * 跨域无 Timing-Allow-Origin 时仍有首字节与字节数。只取数值，不碰 URL。
 */
export function recordHlsLoads(
  hls: HlsPlayer,
  events: HlsEvents,
  origin: number,
  onChange: (snapshot: HlsLoadSnapshot) => void,
  /** 快进目标（秒）。给出时，覆盖该时间点的分片会被标记 coversTarget。 */
  targetSeconds?: number
): () => void {
  const entries: DramaHlsLoad[] = [];
  const fragments = new Map<Fragment, DramaHlsLoad>();
  let truncated = false;
  let stopped = false;
  const at = (time: number) => (positive(time) === undefined ? undefined : round(time - origin));
  const timing = (stats: LoaderStats) => {
    const startMs = at(stats.loading.start);
    const endMs = at(stats.loading.end);
    if (startMs === undefined || endMs === undefined) return;
    const firstByteMs = at(stats.loading.first);
    const bytes = positive(stats.total) ?? positive(stats.loaded);
    return {
      startMs,
      endMs,
      ...(firstByteMs !== undefined ? { firstByteMs } : {}),
      ...(bytes !== undefined && bytes <= 1e12 ? { bytes: Math.round(bytes) } : {}),
    };
  };
  const levelFields = (index: number) => {
    const level = hls.levels[index];
    const bitrate = positive(level?.bitrate);
    const height = positive(level?.height);
    return {
      ...(Number.isInteger(index) && index >= 0 && index <= 64 ? { level: index } : {}),
      ...(bitrate !== undefined && bitrate <= 1e9 ? { bitrate: Math.round(bitrate) } : {}),
      ...(height !== undefined && height <= 32768 ? { height: Math.round(height) } : {}),
    };
  };
  const emit = () => onChange({ entries: entries.map((entry) => ({ ...entry })), truncated });
  const push = (entry: DramaHlsLoad, frag?: Fragment) => {
    if (entries.length >= DRAMA_TIMING_MAX_RESOURCES) {
      truncated = true;
      return emit();
    }
    entries.push(entry);
    if (frag) fragments.set(frag, entry);
    emit();
  };
  const guard =
    <T>(handle: (data: T) => void) =>
    (_event: unknown, data: T) => {
      if (stopped) return;
      try {
        handle(data);
      } catch {
        // 统计字段缺失只丢这一条，不能影响播放。
      }
    };
  const onManifest = guard<ManifestLoadedData>((data) => {
    const loaded = timing(data.stats);
    if (loaded) push({ kind: 'manifest', ...loaded });
  });
  const onLevel = guard<LevelLoadedData>((data) => {
    const loaded = timing(data.stats);
    if (loaded) push({ kind: 'level', track: 'main', ...levelFields(data.level), ...loaded });
  });
  const onAudioTrack = guard<AudioTrackLoadedData>((data) => {
    const loaded = timing(data.stats);
    if (loaded) push({ kind: 'audio_track', track: 'audio', ...loaded });
  });
  const onFragment = guard<FragLoadedData>(({ frag }) => {
    const type: string = frag.type;
    if (type !== 'main' && type !== 'audio') return;
    const loaded = timing(frag.stats);
    if (!loaded) return;
    const init = frag.sn === 'initSegment';
    const mediaMs = positive(frag.duration);
    const covers = !init && coversTarget(frag.start, mediaMs, targetSeconds);
    push(
      {
        kind: init ? 'init' : 'fragment',
        track: type,
        // 音轨分片的 level 是音轨序号，不是画质档位。
        ...(type === 'main' ? levelFields(frag.level) : {}),
        ...(typeof frag.sn === 'number' && frag.sn >= 0 ? { sn: frag.sn } : {}),
        ...(!init && Number.isFinite(frag.start) && frag.start >= 0
          ? { positionMs: round(frag.start * 1000) }
          : {}),
        ...(!init && mediaMs !== undefined ? { mediaMs: round(mediaMs * 1000) } : {}),
        ...(covers ? { coversTarget: true } : {}),
        ...loaded,
      },
      frag
    );
  });
  const onBuffered = guard<FragBufferedData>(({ frag, stats }) => {
    const entry = fragments.get(frag);
    const appendedMs = at(stats.buffering.end);
    if (!entry || appendedMs === undefined || entry.appendedMs !== undefined) return;
    entry.appendedMs = appendedMs;
    emit();
  });
  hls.on(events.MANIFEST_LOADED, onManifest);
  hls.on(events.LEVEL_LOADED, onLevel);
  hls.on(events.AUDIO_TRACK_LOADED, onAudioTrack);
  hls.on(events.FRAG_LOADED, onFragment);
  hls.on(events.FRAG_BUFFERED, onBuffered);
  return () => {
    if (stopped) return;
    stopped = true;
    fragments.clear();
    try {
      hls.off(events.MANIFEST_LOADED, onManifest);
      hls.off(events.LEVEL_LOADED, onLevel);
      hls.off(events.AUDIO_TRACK_LOADED, onAudioTrack);
      hls.off(events.FRAG_LOADED, onFragment);
      hls.off(events.FRAG_BUFFERED, onBuffered);
    } catch {
      /* already destroyed */
    }
  };
}

/** 起播窗口：记录到起播终态为止。 */
export function observeDramaHls(
  hls: HlsPlayer,
  events: HlsEvents,
  timing: DramaPlaybackTiming
): void {
  if (timing.outcome) return;
  const stop = recordHlsLoads(hls, events, timing.startedAt, (snapshot) =>
    timing.hlsTiming(snapshot)
  );
  timing.onFinish(stop);
}
