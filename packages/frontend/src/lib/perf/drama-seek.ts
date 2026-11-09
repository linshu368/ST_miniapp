import type HlsPlayer from 'hls.js';
import type {
  DramaDelivery,
  DramaTimingReport,
  DramaNetworkTiming,
  DramaStartupDiagnostics,
} from '@miniapp/shared';
import { ownsDramaSource } from '../drama-media-source';
import { recordHlsLoads, type HlsEvents } from './drama-hls';
import { observeSeekResources } from './drama-resources';

type End = 'playing' | 'error' | 'switched' | 'left' | 'background' | 'unverified';
type Seek = NonNullable<DramaTimingReport['seek']>;
type Sample = NonNullable<Seek['samples']>[number];
const SAMPLE_INTERVAL_MS = 100;
const MAX_SAMPLES = 32;
const MAX_READS = 100;
const OBSERVATION_LIMIT_MS = 60_000;

/** One passive seek lifetime. It never changes src, currentTime, playback or a media timeout. */
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
    route?: DramaTimingReport['route'];
    sourceAt?: number;
    /** hls.js 路径才有：快进窗口内记录分片加载，并标出覆盖目标时间的分片。 */
    hls?: { player: HlsPlayer; events: HlsEvents };
    now: () => number;
    emit: (report: DramaTimingReport) => void;
  }
) {
  const startedAt = options.now();
  const from = video.currentTime;
  let ended = false;
  let frameId: number | undefined;
  let seekedMs: number | undefined;
  let frameMs: number | undefined;
  let playingMs: number | undefined;
  let resumed = false;
  let positionSetMs: number | undefined;
  let seekingMs: number | undefined;
  let firstBufferedMs: number | undefined;
  let firstMediaTime: number | undefined;
  let frameProcessingMs: number | undefined;
  let frameMethod: DramaTimingReport['frameMethod'];
  let frameSupported = typeof video.requestVideoFrameCallback === 'function';
  let endReason: Seek['endReason'] = 'terminal';
  let samplingCapped = false;
  let samplesTruncated = false;
  let reads = 0;
  const samples: Sample[] = [];
  let finalReport: DramaTimingReport | undefined;
  const elapsed = () => Math.max(0, options.now() - startedAt);
  // hls.js 走 MSE，currentSrc 是 blob: 地址，不能直接和 play_url 比；用播放器登记的所有权判断。
  const current = () => !ended && ownsDramaSource(video, source);
  const readBuffer = (): { buffered: Seek['buffered']; ahead?: number } => {
    try {
      let ahead = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i),
          end = video.buffered.end(i);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
          return { buffered: 'unknown' };
        if (start <= target && end > target) ahead = (end - target) * 1000;
      }
      return { buffered: ahead > 0 ? 'yes' : 'no', ahead };
    } catch {
      return { buffered: 'unknown' };
    }
  };
  const initialBuffer = readBuffer().buffered;
  const record = (event: Sample['event']) => {
    if (!current()) return;
    const buffer = readBuffer();
    if (buffer.buffered === 'yes') firstBufferedMs ??= elapsed();
    try {
      const sample: Sample = {
        atMs: elapsed(),
        event,
        readyState: video.readyState,
        paused: video.paused,
        seeking: video.seeking,
        currentTimeMs:
          Number.isFinite(video.currentTime) && video.currentTime >= 0
            ? video.currentTime * 1000
            : undefined,
        targetBuffered: buffer.buffered,
        targetBufferedAheadMs: buffer.ahead,
      };
      const last = samples.at(-1);
      // Poll only during this seek, store changes only, and bound reads as well as retained detail.
      if (
        event === 'sample' &&
        last &&
        last.readyState === sample.readyState &&
        last.paused === sample.paused &&
        last.seeking === sample.seeking &&
        last.targetBuffered === sample.targetBuffered
      )
        return;
      if (samples.length < MAX_SAMPLES) samples.push(sample);
      else samplesTruncated = true;
    } catch {
      /* Inaccessible native state remains absent. */
    }
  };
  const network = observeSeekResources(source, startedAt, options.sourceAt ?? 0, (snapshot) => {
    if (!finalReport || !ownsDramaSource(video, source)) return;
    try {
      options.emit({
        ...finalReport,
        phase: 'network',
        diagnostics: { ...finalReport.diagnostics, network: snapshot },
      });
    } catch {
      /* Tail delivery never controls playback. */
    }
  });
  let hlsLoads: DramaStartupDiagnostics['hls'];
  let stopHls: (() => void) | undefined;
  if (options.hls) {
    try {
      stopHls = recordHlsLoads(
        options.hls.player,
        options.hls.events,
        startedAt,
        (snapshot) => {
          hlsLoads = snapshot;
        },
        target
      );
    } catch {
      /* 诊断订阅失败不能影响快进。 */
    }
  }
  const buildReport = (
    phase: 'start' | 'slow' | 'final',
    outcome: DramaTimingReport['outcome'],
    networkSnapshot: DramaNetworkTiming
  ): DramaTimingReport => ({
    type: 'seek',
    phase,
    id: options.id,
    dramaId: options.dramaId,
    videoId: options.videoId,
    delivery: options.delivery,
    context: options.context,
    route: options.route,
    ...(options.context ? { version: 2 as const } : {}),
    outcome,
    elapsedMs: elapsed(),
    overFiveSeconds: elapsed() > 5000,
    seek: {
      targetMs: target * 1000,
      buffered: initialBuffer,
      wasPlaying,
      seekedMs,
      frameMs,
      definition: 'drama_seek_resume_v1',
      fromMs: Number.isFinite(from) && from >= 0 ? from * 1000 : undefined,
      direction: !Number.isFinite(from)
        ? 'unknown'
        : target > from
          ? 'forward'
          : target < from
            ? 'backward'
            : 'same',
      positionSetMs,
      seekingMs,
      playingMs,
      firstBufferedMs,
      samplingCapped,
      samplesTruncated,
      endReason,
      samples: samples.map((sample) => ({ ...sample })),
    },
    diagnostics: {
      network: networkSnapshot,
      ...(hlsLoads ? { hls: hlsLoads } : {}),
      ...(frameMs === undefined
        ? {}
        : { frame: { callbackAtMs: frameMs, processingMs: frameProcessingMs } }),
    },
    frameMethod,
    marks: {},
    stages: {},
    queries: [],
  });
  const emit = (phase: 'start' | 'slow' | 'final', outcome: DramaTimingReport['outcome']) => {
    const report = buildReport(phase, outcome, network.snapshot());
    if (phase === 'final') finalReport = report;
    try {
      options.emit(report);
    } catch {
      /* Diagnostic failures cannot break the progress control. */
    }
  };
  const finish = (outcome: End = 'switched') => {
    if (ended) {
      network.release();
      return;
    }
    ended = true;
    clearTimeout(slow);
    clearTimeout(deadline);
    clearInterval(poll);
    for (const name of eventNames) video.removeEventListener(name, onEvent);
    try {
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
    } catch {
      /* native cleanup */
    }
    stopHls?.();
    emit('final', outcome);
    network.finish(
      Boolean(options.context) && (outcome === 'playing' || outcome === 'error'),
      options.now()
    );
  };
  const maybeFinish = () => {
    if (
      current() &&
      wasPlaying &&
      resumed &&
      video.readyState >= 2 &&
      !video.paused &&
      !video.seeking &&
      seekedMs !== undefined &&
      frameMs !== undefined &&
      playingMs !== undefined
    )
      finish('playing');
  };
  const onEvent = (event: Event) => {
    if (!current()) return;
    record(event.type as Sample['event']);
    if (event.type === 'waiting' || event.type === 'seeking') resumed = false;
    if (event.type === 'seeking') seekingMs ??= elapsed();
    if (event.type === 'error') {
      finish('error');
      return;
    }
    if (event.type === 'pause') {
      endReason = 'paused';
      finish('unverified');
      return;
    }
    if (event.type === 'seeked') {
      seekedMs ??= elapsed();
      if (!wasPlaying && !frameSupported) {
        finish('unverified');
        return;
      }
    }
    if (
      seekedMs !== undefined &&
      !video.seeking &&
      !video.paused &&
      video.readyState >= 2 &&
      (event.type === 'playing' ||
        (event.type === 'timeupdate' && video.currentTime > target + 0.01))
    ) {
      resumed = true;
      playingMs ??= elapsed();
      if (!frameSupported && event.type === 'timeupdate') {
        frameMs ??= elapsed();
        frameMethod = 'playing_and_timeupdate';
      }
    }
    maybeFinish();
  };
  const requestFrame = () => {
    if (!frameSupported || !current()) return;
    try {
      frameId = video.requestVideoFrameCallback((_at, metadata) => {
        if (!current()) return;
        if (
          !video.seeking &&
          video.readyState >= 2 &&
          Number.isFinite(metadata.mediaTime) &&
          metadata.mediaTime >= target - 0.25 &&
          Math.abs(metadata.mediaTime - video.currentTime) < 1 &&
          (firstMediaTime !== undefined || metadata.mediaTime <= target + 1)
        ) {
          frameMs ??= elapsed();
          frameMethod = 'video_frame_callback';
          if (
            frameProcessingMs === undefined &&
            typeof metadata.processingDuration === 'number' &&
            Number.isFinite(metadata.processingDuration) &&
            metadata.processingDuration >= 0
          )
            frameProcessingMs = metadata.processingDuration * 1000;
          if (
            firstMediaTime !== undefined &&
            metadata.mediaTime > firstMediaTime + 0.001 &&
            !video.paused
          ) {
            resumed = true;
            playingMs ??= elapsed();
          }
          firstMediaTime ??= metadata.mediaTime;
          record('frame');
          if (!wasPlaying) {
            finish('unverified');
            return;
          }
          maybeFinish();
        }
        if (!ended) requestFrame();
      });
    } catch {
      frameSupported = false;
    }
  };
  const eventNames = [
    'seeking',
    'seeked',
    'progress',
    'waiting',
    'canplay',
    'playing',
    'pause',
    'timeupdate',
    'error',
  ] as const;
  for (const name of eventNames) video.addEventListener(name, onEvent);
  record('commit');
  const poll = setInterval(() => {
    if (!current()) {
      finish('switched');
      return;
    }
    record('sample');
    if (++reads >= MAX_READS) {
      samplingCapped = true;
      clearInterval(poll);
    }
  }, SAMPLE_INTERVAL_MS);
  const slow = setTimeout(() => {
    if (!ended) emit('slow', 'waiting');
  }, 5001);
  // Bounds diagnostics only. The media continues after the observation becomes unverified.
  const deadline = setTimeout(() => {
    endReason = 'deadline';
    finish('unverified');
  }, OBSERVATION_LIMIT_MS);
  if (options.context) emit('start', 'waiting');
  requestFrame();
  return Object.assign(finish, {
    positionSet: () => {
      if (current()) {
        positionSetMs ??= elapsed();
        record('position_set');
      }
    },
  });
}
