import type { DramaPlaybackTiming } from './drama-timing';
import type { DramaMediaEvent, DramaMediaState } from '@miniapp/shared';
import { observeDramaLongTasks, observeDramaResources } from './drama-resources';
import { getMetricDimensions } from './env-tags';
import {
  isEngineeringTelemetryEnabled,
  recordEngineeringEvent,
  recordEngineeringMeasurement,
} from './grafana';

function mediaState(video: HTMLVideoElement): DramaMediaState {
  const currentTime = video.currentTime;
  let bufferedAheadMs: number | undefined;
  if (Number.isFinite(currentTime) && currentTime >= 0) {
    try {
      bufferedAheadMs = 0;
      // 只算覆盖当前位置的连续区间；跨缓冲空洞的远端区间不能当作可播缓冲。
      const buffered = video.buffered;
      for (let index = 0; index < buffered.length; index += 1) {
        const start = buffered.start(index);
        const end = buffered.end(index);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          bufferedAheadMs = undefined;
          break;
        }
        if (start <= currentTime && end > currentTime) {
          bufferedAheadMs = Math.round((end - currentTime) * 1000);
          break;
        }
      }
    } catch {
      // 属性不可读表示未知，不能伪装成零缓冲。
      bufferedAheadMs = undefined;
    }
  }
  return {
    readyState: video.readyState,
    networkState: video.networkState,
    paused: video.paused,
    muted: video.muted,
    seeking: video.seeking,
    currentTimeMs:
      Number.isFinite(currentTime) && currentTime >= 0 ? Math.round(currentTime * 1000) : undefined,
    bufferedAheadMs,
    visibility:
      typeof document === 'undefined' ? 'unknown' : document.hidden ? 'hidden' : 'visible',
  };
}

function playError(error: unknown): NonNullable<DramaMediaEvent['error']> {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return 'not_allowed';
    if (error.name === 'AbortError') return 'aborted';
    if (error.name === 'NotSupportedError') return 'not_supported';
  }
  return 'other';
}

/**
 * 每次 src 赋值独立绑定。结束或切换后所有迟到事件/帧回调都失效；
 * 媒体 URL 只用于同源代际校验，绝不送到报告器。
 */
export function observeDramaMedia(
  video: HTMLVideoElement,
  source: string,
  timing: DramaPlaybackTiming
) {
  let disposed = false;
  let playing = false;
  let frame = false;
  let callbackId: number | undefined;
  let useFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  let rebufferAt: number | undefined;
  const rebufferAttributes = {
    route: timing.owner === 'home' ? '/' : '/dramas/:id',
    report_kind: 'playback',
    stage: 'rebuffer',
    playback_mode: timing.entry,
    source_measurement_version: 'drama_rebuffer_v1',
  };
  const visible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';
  const qualityEnabled = isEngineeringTelemetryEnabled();
  let qualityState: 'playing' | 'waiting' | undefined;
  let qualityAt = 0;
  let qualityWindowAt = 0;
  let qualityPlayingMs = 0;
  let qualityRebufferMs = 0;
  let qualityDimensions: ReturnType<typeof getMetricDimensions> | undefined;
  let qualityTimer: ReturnType<typeof setTimeout> | undefined;
  let qualitySawPlaying = false;
  let qualityFrame = false;
  let qualityMediaTime = video.currentTime;
  const qualityEligible = () =>
    !disposed &&
    video.currentSrc === source &&
    visible() &&
    !video.paused &&
    !video.seeking &&
    !video.ended;
  const readQualityDimensions = (): ReturnType<typeof getMetricDimensions> => {
    try {
      return { ...getMetricDimensions() };
    } catch {
      return { net_type: 'unknown', tg_platform: 'unknown' };
    }
  };
  const settleQuality = (now: number) => {
    if (!qualityState) return;
    const elapsed = now - qualityAt;
    // A suspended event loop is not proof that video kept playing. Never fill
    // an unobserved long gap with playback or buffering time.
    if (elapsed >= 0 && elapsed <= 60_000) {
      if (qualityState === 'playing') qualityPlayingMs += elapsed;
      else qualityRebufferMs += elapsed;
    }
    qualityAt = now;
  };
  const flushQuality = () => {
    const now = performance.now();
    settleQuality(now);
    const playingMs = Math.round(qualityPlayingMs);
    const rebufferMs = Math.round(qualityRebufferMs);
    const dimensions = qualityDimensions;
    const validWindow = now - qualityWindowAt <= 60_000 && playingMs + rebufferMs <= 60_000;
    qualityPlayingMs = 0;
    qualityRebufferMs = 0;
    qualityDimensions = undefined;
    qualityWindowAt = now;
    if (qualityState) qualityDimensions = readQualityDimensions();
    if (!dimensions || !validWindow || playingMs + rebufferMs === 0) return;
    const endDimensions = readQualityDimensions();
    try {
      // Keep both deltas in one record: independently dropped numerator and
      // denominator signals would manufacture a misleading buffering ratio.
      recordEngineeringEvent('drama.playback_window', {
        route: timing.owner === 'home' ? '/' : '/dramas/:id',
        report_kind: 'playback',
        stage: 'playback',
        playback_mode: timing.entry,
        source_measurement_version: 'drama_playback_v1',
        ...dimensions,
        net_type: dimensions.net_type === endDimensions.net_type ? dimensions.net_type : 'mixed',
        playing_ms: playingMs,
        rebuffer_ms: rebufferMs,
      });
    } catch {
      // Best-effort telemetry never retries or changes media behavior.
    }
  };
  const armQualityTimer = () => {
    if (!qualityEnabled || disposed || !qualityState || qualityTimer !== undefined) return;
    qualityTimer = setTimeout(() => {
      qualityTimer = undefined;
      if (!qualityEligible()) {
        // A missed pause/visibility event leaves an unconfirmed tail. Preserve
        // earlier settled deltas, but do not backfill that tail as playback.
        qualityState = undefined;
        qualitySawPlaying = false;
      }
      flushQuality();
      armQualityTimer();
    }, 30_000);
  };
  const changeQuality = (next: typeof qualityState) => {
    if (!qualityEnabled || disposed) return;
    const now = performance.now();
    settleQuality(now);
    qualityState = next;
    qualityAt = now;
    if (next && !qualityDimensions) {
      qualityDimensions = readQualityDimensions();
      qualityWindowAt = now;
    }
    if (!next && qualityTimer !== undefined) {
      clearTimeout(qualityTimer);
      qualityTimer = undefined;
    }
    armQualityTimer();
  };
  const stopQuality = () => {
    if (!qualityEnabled || disposed) return;
    changeQuality(undefined);
    qualitySawPlaying = false;
    flushQuality();
  };
  const observeQualityPlaying = () => {
    if (!qualityEnabled) return;
    if (!qualityEligible()) {
      stopQuality();
      return;
    }
    qualitySawPlaying = true;
    if (qualityFrame) changeQuality('playing');
  };
  const confirmQualityFrame = () => {
    if (!qualityEnabled || disposed || video.currentSrc !== source || video.readyState < 2) return;
    qualityFrame = true;
    if (qualitySawPlaying && qualityState !== 'waiting' && qualityEligible())
      changeQuality('playing');
  };
  const observeQualityProgress = () => {
    if (!qualityEnabled || disposed) return;
    if (video.currentSrc !== source) {
      stopQuality();
      return;
    }
    const progressed = Number.isFinite(video.currentTime) && video.currentTime > qualityMediaTime;
    qualityMediaTime = video.currentTime;
    // Natural progress also covers a manual retry after startup's immutable
    // autoplay_blocked outcome, without rewriting that earlier result.
    if (progressed && qualitySawPlaying && qualityState !== 'waiting' && qualityEligible())
      confirmQualityFrame();
  };
  const finishRebuffer = (
    outcome:
      | 'playing'
      | 'paused'
      | 'seek'
      | 'background'
      | 'error'
      | 'ended'
      | 'disposed'
      | 'switched'
  ) => {
    if (rebufferAt === undefined) return;
    const duration = performance.now() - rebufferAt;
    rebufferAt = undefined;
    try {
      const attributes = { ...rebufferAttributes, outcome };
      recordEngineeringMeasurement('drama.rebuffer', duration, attributes);
      recordEngineeringEvent('drama.stall', attributes);
    } catch {
      // Optional post-startup diagnostics cannot affect the media element.
    }
  };
  const beginRebuffer = () => {
    // Waiting during initial load is startup, not rebuffering. Exclude explicit
    // pause/seek/background. A network stalled event can occur while buffered
    // video is still playing, so only waiting is evidence of a playback stall.
    if (
      disposed ||
      timing.outcome !== 'playing' ||
      video.currentSrc !== source ||
      !visible() ||
      video.paused ||
      video.seeking ||
      rebufferAt !== undefined
    )
      return;
    rebufferAt = performance.now();
    try {
      recordEngineeringEvent('drama.stall', { ...rebufferAttributes, outcome: 'waiting' });
    } catch {
      // One scalar interval, no polling, buffering, or player state changes.
    }
  };
  const pauseRebuffer = () => {
    stopQuality();
    finishRebuffer('paused');
  };
  const seekRebuffer = () => {
    stopQuality();
    finishRebuffer('seek');
  };
  const endRebuffer = () => {
    stopQuality();
    finishRebuffer('ended');
  };
  const visibilityRebuffer = () => {
    if (!visible()) {
      stopQuality();
      finishRebuffer('background');
    }
  };
  // 本观察器只绑定新 src，旧视频的 currentTime 不能作为新视频的推进基线。
  const initialTime = 0;
  const stopResources = observeDramaResources(source, timing);
  const stopLongTasks = observeDramaLongTasks(timing);
  const current = () => !disposed && !timing.outcome && video.currentSrc === source;
  const unbindState = timing.bindMediaState(() =>
    !disposed && video.currentSrc === source ? mediaState(video) : undefined
  );
  const complete = () => {
    if (playing && frame && current()) timing.finish('playing');
  };
  const metadata = () => {
    if (current()) {
      timing.mark('metadata');
      timing.mediaEvent('loadedmetadata');
    }
  };
  const onPlaying = () => {
    observeQualityPlaying();
    finishRebuffer(
      video.currentSrc !== source
        ? 'switched'
        : !visible()
          ? 'background'
          : video.seeking
            ? 'seek'
            : video.paused
              ? 'paused'
              : 'playing'
    );
    if (!current()) return;
    playing = true;
    timing.mark('playing');
    timing.mediaEvent('playing');
    complete();
  };
  const onTimeUpdate = () => {
    observeQualityProgress();
    if (
      useFrameCallback ||
      !playing ||
      !current() ||
      video.currentTime <= initialTime ||
      video.readyState < 2
    )
      return;
    frame = true;
    timing.frameMethod = 'playing_and_timeupdate';
    timing.mark('first_frame');
    timing.mediaEvent('first_frame');
    complete();
  };
  const error = () => {
    stopQuality();
    finishRebuffer('error');
    if (current()) timing.finish('error');
  };
  video.addEventListener('loadedmetadata', metadata);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('error', error);
  video.addEventListener('pause', pauseRebuffer);
  video.addEventListener('seeking', seekRebuffer);
  video.addEventListener('ended', endRebuffer);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', visibilityRebuffer);
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', stopQuality);
  const diagnosticEvents = [
    'loadeddata',
    'canplay',
    'play',
    'waiting',
    'stalled',
    'suspend',
    'pause',
  ] as const;
  const onDiagnosticEvent = (event: Event) => {
    if (event.type === 'waiting' && qualityEligible()) {
      if (qualityState) changeQuality('waiting');
      // A late frame/progress callback cannot prove recovery from a wait that
      // arrived before the first confirmed quality-playback interval.
      else qualitySawPlaying = false;
    }
    if (event.type === 'waiting') beginRebuffer();
    if (!current()) return;
    const name = diagnosticEvents.find((name) => name === event.type);
    if (!name) return;
    if (name === 'loadeddata' || name === 'canplay') timing.mark(name);
    timing.mediaEvent(name);
  };
  for (const name of diagnosticEvents) video.addEventListener(name, onDiagnosticEvent);

  const requestFrame = () => {
    if (!useFrameCallback) return;
    try {
      callbackId = video.requestVideoFrameCallback((_at, metadata) => {
        confirmQualityFrame();
        if (disposed || timing.outcome) return;
        // 换 src 后第一条回调仍可能属于上一资源，继续等本次资源的帧。
        if (!current() || video.readyState < 2) {
          requestFrame();
          return;
        }
        frame = true;
        timing.recordFrame({
          callbackAtMs: Math.max(0, timing.offset()),
          presentationAtMs:
            metadata && Number.isFinite(metadata.presentationTime)
              ? timing.offset(metadata.presentationTime)
              : undefined,
          expectedDisplayAtMs:
            metadata && Number.isFinite(metadata.expectedDisplayTime)
              ? timing.offset(metadata.expectedDisplayTime)
              : undefined,
          processingMs:
            metadata &&
            typeof metadata.processingDuration === 'number' &&
            Number.isFinite(metadata.processingDuration) &&
            metadata.processingDuration >= 0
              ? metadata.processingDuration * 1000
              : undefined,
          width:
            metadata && metadata.width > 0 && metadata.width <= 32768 ? metadata.width : undefined,
          height:
            metadata && metadata.height > 0 && metadata.height <= 32768
              ? metadata.height
              : undefined,
        });
        timing.frameMethod = 'video_frame_callback';
        timing.mark('first_frame');
        timing.mediaEvent('first_frame');
        complete();
      });
    } catch {
      useFrameCallback = false;
    }
  };
  requestFrame();
  return {
    playCalled(trigger: 'automatic' | 'user') {
      if (disposed || timing.outcome) return;
      timing.mark('play_called');
      timing.mediaEvent('play_called', { trigger });
    },
    resolved(trigger: 'automatic' | 'user') {
      if (disposed || timing.outcome) return;
      timing.mark('play_resolved');
      timing.mediaEvent('play_resolved', { trigger });
    },
    rejected(error: unknown, trigger: 'automatic' | 'user' = 'automatic') {
      if (disposed || timing.outcome) return;
      timing.mark('play_rejected');
      timing.mediaEvent('play_rejected', { trigger, error: playError(error) });
      // 手动 play 的拒绝原本只更新 UI，观测不能增加新的业务终态。
      if (trigger === 'user') return;
      // AbortError 常来自释放旧 src，不能当作网络错误，更不能污染下一次播放。
      if (error instanceof Error && error.name === 'AbortError') return;
      timing.finish(
        error instanceof Error && error.name === 'NotAllowedError' ? 'autoplay_blocked' : 'error'
      );
    },
    dispose() {
      stopQuality();
      finishRebuffer(video.currentSrc === source ? 'disposed' : 'switched');
      stopResources();
      stopLongTasks();
      disposed = true;
      unbindState();
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('error', error);
      video.removeEventListener('pause', pauseRebuffer);
      video.removeEventListener('seeking', seekRebuffer);
      video.removeEventListener('ended', endRebuffer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibilityRebuffer);
      }
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', stopQuality);
      for (const name of diagnosticEvents) video.removeEventListener(name, onDiagnosticEvent);
      if (callbackId !== undefined && typeof video.cancelVideoFrameCallback === 'function')
        video.cancelVideoFrameCallback(callbackId);
    },
  };
}
