import {
  reportVoicePlayback,
  voiceMediaFailure,
  voicePlaybackFailure,
  type VoicePlaybackFailure,
  type VoicePlaybackPhase,
} from './voice-playback-report';

export const VOICE_PLAYBACK_TIMEOUT_MS = 15_000;
let activePlayback: { stop: () => void } | undefined;

interface PlaybackCallbacks {
  playing: (value: boolean) => void;
  failure: (reason: VoicePlaybackFailure | null) => void;
}

/** One source per controller; disposal invalidates pending play promises before pause. */
export function createVoicePlayback(player: HTMLAudioElement, callbacks: PlaybackCallbacks) {
  return new VoicePlayback(player, callbacks);
}

class VoicePlayback {
  private disposed = false;
  private attempt = 0;
  private requested = false;
  private failed = false;
  private progressed = false;
  private startedAt = performance.now();
  private phase: VoicePlaybackPhase = 'preload';
  private lastPosition: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private removeListeners: () => void;

  constructor(
    private player: HTMLAudioElement,
    private callbacks: PlaybackCallbacks
  ) {
    this.lastPosition = player.currentTime;
    this.removeListeners = bindPlaybackEvents(player, {
      play: () => {
        if (this.requested) callbacks.playing(true);
      },
      playing: () => {
        if (this.requested) callbacks.playing(true);
      },
      pause: () => {
        if (this.requested && player.paused) this.stop();
      },
      ended: () => this.stop(),
      error: () => {
        if (player.error && (this.requested || this.phase === 'preload'))
          this.fail(voiceMediaFailure(player.error.code));
      },
      timeupdate: () => this.progress(),
    });
    document.addEventListener('visibilitychange', this.armTimer);
    // Preloading can fail before React attaches the controller.
    if (player.error) this.fail(voiceMediaFailure(player.error.code));
  }

  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private armTimer = () => {
    this.clearTimer();
    if (this.requested && document.visibilityState === 'visible') {
      this.timer = setTimeout(() => {
        if (this.requested && document.visibilityState === 'visible') this.fail('timeout');
      }, VOICE_PLAYBACK_TIMEOUT_MS);
    }
  };

  stop = () => {
    if (this.requested && !this.player.ended)
      reportVoicePlayback('cancelled', this.player, this.phase, this.startedAt);
    this.requested = false;
    this.attempt += 1;
    this.clearTimer();
    if (activePlayback === this) activePlayback = undefined;
    this.player.pause();
    if (!this.disposed) this.callbacks.playing(false);
  };

  private fail(reason: VoicePlaybackFailure) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.requested = false;
    this.attempt += 1;
    this.clearTimer();
    if (activePlayback === this) activePlayback = undefined;
    reportVoicePlayback('failed', this.player, this.phase, this.startedAt, reason);
    this.player.pause();
    this.callbacks.playing(false);
    this.callbacks.failure(reason);
  }

  toggle = (rate: number) => {
    if (this.disposed) return;
    if (this.requested) {
      this.stop();
      return;
    }
    activePlayback?.stop();
    activePlayback = this;
    const attempt = ++this.attempt;
    const reload = this.failed || Boolean(this.player.error);
    this.requested = true;
    this.failed = false;
    this.progressed = false;
    this.phase = 'starting';
    this.startedAt = performance.now();
    this.lastPosition = this.player.currentTime;
    this.callbacks.failure(null);
    reportVoicePlayback('started', this.player, this.phase, this.startedAt);
    this.armTimer();
    const rejected = (error: unknown) => {
      if (!this.disposed && this.requested && this.attempt === attempt)
        this.fail(voicePlaybackFailure(error));
    };
    try {
      if (reload) this.player.load();
      this.player.playbackRate = rate;
      void this.player.play().catch(rejected);
    } catch (error) {
      rejected(error);
    }
  };

  private progress() {
    if (
      !this.requested ||
      this.player.paused ||
      this.player.currentTime === this.lastPosition ||
      this.player.seeking
    )
      return;
    this.lastPosition = this.player.currentTime;
    this.phase = 'playback';
    if (!this.progressed) {
      this.progressed = true;
      reportVoicePlayback('progress', this.player, this.phase, this.startedAt);
    }
    this.armTimer();
  }

  dispose = () => {
    this.disposed = true;
    this.removeListeners();
    document.removeEventListener('visibilitychange', this.armTimer);
    this.stop();
  };
}

function bindPlaybackEvents(
  player: HTMLAudioElement,
  listeners: Record<'play' | 'playing' | 'pause' | 'ended' | 'error' | 'timeupdate', () => void>
): () => void {
  for (const [event, listener] of Object.entries(listeners))
    player.addEventListener(event, listener);
  return () => {
    for (const [event, listener] of Object.entries(listeners))
      player.removeEventListener(event, listener);
  };
}
