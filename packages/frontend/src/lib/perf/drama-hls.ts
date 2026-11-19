import type HlsPlayer from 'hls.js';
import type {
  AudioTrackLoadedData,
  ErrorData,
  Events,
  FragBufferedData,
  FragLoadEmergencyAbortedData,
  FragLoadedData,
  FragLoadingData,
  Fragment,
  LevelLoadedData,
  LevelSwitchingData,
  LoaderStats,
  ManifestLoadedData,
} from 'hls.js';
import {
  DRAMA_TIMING_MAX_HLS_EVENTS,
  DRAMA_TIMING_MAX_RESOURCES,
  type DramaHlsEvent,
  type DramaHlsEventCounts,
  type DramaHlsLoad,
  type DramaStartupDiagnostics,
} from '@miniapp/shared';
import type { DramaPlaybackTiming } from './drama-timing';
import { prefetchUsage, takePrefetchDiscarded } from '@/lib/drama-playback-resources';

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

const relativeMs = (origin: number, time: number) =>
  positive(time) === undefined ? undefined : round(time - origin);

/** 独立成顶层函数只是为了不让 recordHlsLoads 继续变长，不涉及可复用性。 */
function loadTimingFields(origin: number, stats: LoaderStats) {
  const startMs = relativeMs(origin, stats.loading.start);
  const endMs = relativeMs(origin, stats.loading.end);
  if (startMs === undefined || endMs === undefined) return undefined;
  const firstByteMs = relativeMs(origin, stats.loading.first);
  const bytes = positive(stats.total) ?? positive(stats.loaded);
  return {
    startMs,
    endMs,
    ...(firstByteMs !== undefined ? { firstByteMs } : {}),
    ...(bytes !== undefined && bytes <= 1e12 ? { bytes: Math.round(bytes) } : {}),
  };
}

function loadLevelFields(hls: HlsPlayer, index: number) {
  const level = hls.levels[index];
  const bitrate = positive(level?.bitrate);
  const height = positive(level?.height);
  return {
    ...(Number.isInteger(index) && index >= 0 && index <= 64 ? { level: index } : {}),
    ...(bitrate !== undefined && bitrate <= 1e9 ? { bitrate: Math.round(bitrate) } : {}),
    ...(height !== undefined && height <= 32768 ? { height: Math.round(height) } : {}),
  };
}

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
  targetSeconds?: number,
  /** 本次主清单是否来自后端内联下发；原样放进每次 snapshot，不参与加载逻辑。 */
  manifestInline?: boolean,
  /** 播放资源缓存的使用情况；loader 应答子清单后会变化，所以每次 snapshot 现取。 */
  prefetch?: () => HlsLoadSnapshot['prefetch']
): () => void {
  const entries: DramaHlsLoad[] = [];
  const fragments = new Map<Fragment, DramaHlsLoad>();
  let truncated = false;
  let stopped = false;
  const at = (time: number) => relativeMs(origin, time);
  const timing = (stats: LoaderStats) => loadTimingFields(origin, stats);
  const levelFields = (index: number) => loadLevelFields(hls, index);
  const emit = () =>
    onChange({
      entries: entries.map((entry) => ({ ...entry })),
      truncated,
      ...(manifestInline ? { manifestInline: true } : {}),
      ...(prefetch ? { prefetch: prefetch() } : {}),
    });
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

type HlsEventSnapshot = Required<
  Pick<HlsLoadSnapshot, 'events' | 'eventsTruncated' | 'eventCounts'>
>;

const EVENT_COUNT_KEYS = {
  frag_loading: 'fragLoading',
  frag_emergency_aborted: 'emergencyAborted',
  level_switching: 'levelSwitching',
  error: 'error',
} as const satisfies Record<DramaHlsEvent['type'], keyof DramaHlsEventCounts>;
const ERROR_DETAIL = /^[A-Za-z]{1,48}$/;
const MAX_EVENT_COUNT = 100000;
const HEAD_EVENTS = DRAMA_TIMING_MAX_HLS_EVENTS / 2;

/** 分片只取轨道、sn 和画质档位；init 段没有数字 sn，音轨分片的 level 是音轨序号，都不记。 */
function eventFragFields(frag: Fragment | undefined): Partial<DramaHlsEvent> {
  if (!frag) return {};
  const type: string = frag.type;
  if (type !== 'main' && type !== 'audio') return {};
  return {
    track: type,
    ...(typeof frag.sn === 'number' && frag.sn >= 0 ? { sn: frag.sn } : {}),
    ...(type === 'main' && Number.isInteger(frag.level) && frag.level >= 0 && frag.level <= 64
      ? { level: frag.level }
      : {}),
  };
}

/**
 * 快进窗口里 hls.js 的加载过程事件。`recordHlsLoads` 只看得到加载完成的分片，
 * 卡死时目标分片从来没加载完，要靠这些事件区分是分片反复重发、档位反复切换、错误重试还是紧急中止。
 *
 * hls.js 每次中止分片都会发一条非致命 ERROR（details=aborted），中止重发循环每秒约 20 条，
 * 只留前 24 条只能覆盖开头约 1 秒。所以保留最早 12 条（快进刚开始）和最近 12 条
 * （放弃前的稳定循环），中间的只在 eventCounts 里累计，循环规模不丢。
 */
export function recordHlsEvents(
  hls: HlsPlayer,
  events: HlsEvents,
  elapsed: () => number,
  onChange: (snapshot: HlsEventSnapshot) => void
): () => void {
  const head: DramaHlsEvent[] = [];
  const tail: DramaHlsEvent[] = [];
  const counts: DramaHlsEventCounts = {
    fragLoading: 0,
    emergencyAborted: 0,
    levelSwitching: 0,
    error: 0,
  };
  let truncated = false;
  let stopped = false;
  const push = (type: DramaHlsEvent['type'], fields: Partial<DramaHlsEvent>) => {
    const key = EVENT_COUNT_KEYS[type];
    counts[key] = Math.min(counts[key] + 1, MAX_EVENT_COUNT);
    const event = { ...fields, atMs: round(elapsed()), type };
    if (head.length < HEAD_EVENTS) head.push(event);
    else if (tail.push(event) > DRAMA_TIMING_MAX_HLS_EVENTS - HEAD_EVENTS) {
      tail.shift();
      truncated = true;
    }
    onChange({
      events: [...head, ...tail].map((item) => ({ ...item })),
      eventsTruncated: truncated,
      eventCounts: { ...counts },
    });
  };
  const guard =
    <T>(handle: (data: T) => void) =>
    (_event: unknown, data: T) => {
      if (stopped) return;
      try {
        handle(data);
      } catch {
        // 诊断字段缺失只丢这一条，不能影响播放。
      }
    };
  const onLoading = guard<FragLoadingData>(({ frag }) =>
    push('frag_loading', eventFragFields(frag))
  );
  const onAborted = guard<FragLoadEmergencyAbortedData>(({ frag }) =>
    push('frag_emergency_aborted', eventFragFields(frag))
  );
  const onSwitching = guard<LevelSwitchingData>(({ level }) =>
    push('level_switching', Number.isInteger(level) && level >= 0 && level <= 64 ? { level } : {})
  );
  const onError = guard<ErrorData>((data) => {
    const detail: string = data.details;
    push('error', {
      ...eventFragFields(data.frag),
      ...(ERROR_DETAIL.test(detail) ? { detail } : {}),
      fatal: data.fatal === true,
    });
  });
  hls.on(events.FRAG_LOADING, onLoading);
  hls.on(events.FRAG_LOAD_EMERGENCY_ABORTED, onAborted);
  hls.on(events.LEVEL_SWITCHING, onSwitching);
  hls.on(events.ERROR, onError);
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      hls.off(events.FRAG_LOADING, onLoading);
      hls.off(events.FRAG_LOAD_EMERGENCY_ABORTED, onAborted);
      hls.off(events.LEVEL_SWITCHING, onSwitching);
      hls.off(events.ERROR, onError);
    } catch {
      /* already destroyed */
    }
  };
}

/** 快进窗口：加载统计（标记覆盖目标的分片）加上加载过程事件，合成同一份 hls 诊断。 */
export function recordSeekHls(
  hls: { player: HlsPlayer; events: HlsEvents },
  origin: number,
  now: () => number,
  targetSeconds: number,
  onChange: (snapshot: HlsLoadSnapshot) => void
): () => void {
  let loads: HlsLoadSnapshot = { entries: [], truncated: false };
  let process: HlsEventSnapshot | undefined;
  const emit = () => onChange({ ...loads, ...process });
  const stopLoads = recordHlsLoads(
    hls.player,
    hls.events,
    origin,
    (snapshot) => {
      loads = snapshot;
      emit();
    },
    targetSeconds
  );
  let stopEvents: (() => void) | undefined;
  try {
    stopEvents = recordHlsEvents(
      hls.player,
      hls.events,
      () => now() - origin,
      (snapshot) => {
        process = snapshot;
        emit();
      }
    );
  } catch {
    /* 事件订阅失败时仍保留加载统计。 */
  }
  return () => {
    stopLoads();
    stopEvents?.();
  };
}

/** 起播窗口：记录到起播终态为止。 */
export function observeDramaHls(
  hls: HlsPlayer,
  events: HlsEvents,
  timing: DramaPlaybackTiming,
  manifestInline?: boolean
): void {
  if (timing.outcome) return;
  const usage = prefetchUsage(hls);
  // 丢弃计数每次起播只领取一次，避免同一批浪费在多份报告里重复计算。
  const discarded = takePrefetchDiscarded();
  const stop = recordHlsLoads(
    hls,
    events,
    timing.startedAt,
    (snapshot) => timing.hlsTiming(snapshot),
    undefined,
    manifestInline,
    () => ({ playlists: 0, bytes: 0, ...usage, ...discarded })
  );
  timing.onFinish(stop);
}
