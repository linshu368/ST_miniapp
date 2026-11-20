import * as Sentry from '@sentry/nextjs';
import { getMetricDimensions } from '@/lib/perf/env-tags';
import { sendSentryLog } from '@/lib/sentry/client';

export type VoicePlaybackFailure =
  | 'not_allowed'
  | 'aborted'
  | 'network'
  | 'decode'
  | 'not_supported'
  | 'timeout'
  | 'other';
export type VoicePlaybackPhase = 'preload' | 'starting' | 'playback';
type PlaybackEvent = 'started' | 'progress' | 'cancelled' | 'failed';
const lastWarning = new Map<VoicePlaybackFailure, number>();

export function voicePlaybackFailure(error: unknown): VoicePlaybackFailure {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError') return 'not_allowed';
  if (name === 'AbortError') return 'aborted';
  if (name === 'NotSupportedError') return 'not_supported';
  return 'other';
}

export function voiceMediaFailure(code: number | undefined): VoicePlaybackFailure {
  if (code === 1) return 'aborted';
  if (code === 2) return 'network';
  if (code === 3) return 'decode';
  if (code === 4) return 'not_supported';
  return 'other';
}

export function voicePlaybackHint(reason: VoicePlaybackFailure): string {
  if (reason === 'not_allowed') return '播放未获允许，请再次点击播放';
  if (reason === 'timeout' || reason === 'network') return '语音加载失败，请检查网络后重试播放';
  if (reason === 'decode' || reason === 'not_supported')
    return '这段语音暂时无法播放，请重试或重新打开页面';
  if (reason === 'aborted') return '播放已中断，请重试播放';
  return '语音播放失败，请重试播放';
}

function milliseconds(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : undefined;
}

/** Only project media scalars: Error.message and audio URLs can contain private data. */
export function reportVoicePlayback(
  event: PlaybackEvent,
  player: HTMLAudioElement,
  phase: VoicePlaybackPhase,
  startedAt: number,
  reason?: VoicePlaybackFailure
): void {
  try {
    const attributes = {
      route: '/chat/:characterId',
      stage: phase,
      outcome:
        event === 'failed'
          ? reason === 'timeout'
            ? 'timed_out'
            : reason === 'not_allowed'
              ? 'rejected'
              : 'failed'
          : event === 'started'
            ? 'pending'
            : event === 'progress'
              ? 'succeeded'
              : 'cancelled',
      reason,
      elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      media_error_code: player.error?.code,
      ready_state: player.readyState,
      network_state: player.networkState,
      current_time_ms: milliseconds(player.currentTime),
      duration_ms: milliseconds(player.duration),
      muted: player.muted,
      volume: player.volume,
      playback_rate: player.playbackRate,
      visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
      ...getMetricDimensions(),
    };
    sendSentryLog(event === 'failed' ? 'warn' : 'info', `voice.playback.${event}`, attributes);
    if (event !== 'failed' || !reason) return;
    const now = Date.now();
    const last = lastWarning.get(reason);
    if (last !== undefined && now - last < 60_000) return;
    lastWarning.set(reason, now);
    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setFingerprint(['voice.playback.failed', reason]);
      scope.setTags({ operation: 'voice.playback', reason });
      scope.setContext('voice_playback', attributes);
      Sentry.captureMessage('voice.playback.failed');
    });
  } catch {
    // Playback and recovery must remain usable if telemetry is unavailable.
  }
}
