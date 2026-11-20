import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoicePlaybackFailure } from './voice-playback-report';

const telemetry = vi.hoisted(() => ({
  log: vi.fn(),
  capture: vi.fn(),
  context: vi.fn(),
  fingerprint: vi.fn(),
}));
vi.mock('@/lib/sentry/client', () => ({ sendSentryLog: telemetry.log }));
vi.mock('@/lib/perf/env-tags', () => ({
  getMetricDimensions: () => ({ tg_platform: 'android', net_type: '4g' }),
}));
vi.mock('@sentry/nextjs', () => ({
  captureMessage: telemetry.capture,
  withScope: (callback: (scope: object) => void) =>
    callback({
      setLevel: vi.fn(),
      setTags: vi.fn(),
      setContext: telemetry.context,
      setFingerprint: telemetry.fingerprint,
    }),
}));

class Audio extends EventTarget {
  currentTime = 0;
  duration = 12;
  readyState = 1;
  networkState = 2;
  paused = true;
  ended = false;
  seeking = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  error: { code: number } | null = null;
  src = 'https://private.example/audio.mp3?credential=never-log';
  play = vi.fn((): Promise<void> => {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
  load = vi.fn(() => {
    this.error = null;
    this.currentTime = 0;
  });
}

let create: typeof import('./voice-playback').createVoicePlayback;
let player: Audio;
let visibility: EventTarget & { visibilityState: string };
let playing: ReturnType<typeof vi.fn<(value: boolean) => void>>;
let failure: ReturnType<typeof vi.fn<(reason: VoicePlaybackFailure | null) => void>>;
let controllers: ReturnType<typeof create>[];
const attach = (audio = player) => {
  const result = create(audio as unknown as HTMLAudioElement, { playing, failure });
  controllers.push(result);
  return result;
};
const failedLogs = () =>
  telemetry.log.mock.calls.filter(([, event]) => event === 'voice.playback.failed');
const progress = (seconds: number) => {
  player.currentTime = seconds;
  player.dispatchEvent(new Event('timeupdate'));
};

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', visibility);
  create = (await import('./voice-playback')).createVoicePlayback;
  player = new Audio();
  playing = vi.fn();
  failure = vi.fn();
  controllers = [];
});
afterEach(() => {
  controllers.forEach((controller) => controller.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('voice playback failure and recovery', () => {
  it('reports policy rejection with safe media state and retries only on explicit click', async () => {
    player.play.mockRejectedValueOnce(new DOMException('private audio URL', 'NotAllowedError'));
    const controller = attach();
    controller.toggle(1.5);
    await Promise.resolve();
    expect(failure).toHaveBeenLastCalledWith('not_allowed');
    expect(failedLogs()).toHaveLength(1);
    expect(failedLogs()[0]?.[2]).toMatchObject({
      reason: 'not_allowed',
      playback_rate: 1.5,
      muted: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.play).toHaveBeenCalledTimes(1);
    controller.toggle(1);
    await Promise.resolve();
    progress(1);
    expect(failure).toHaveBeenLastCalledWith(null);
    expect(playing).toHaveBeenLastCalledWith(true);
    expect(telemetry.log.mock.calls.some(([, event]) => event === 'voice.playback.progress')).toBe(
      true
    );
    const output = JSON.stringify([telemetry.log.mock.calls, telemetry.context.mock.calls]);
    expect(output).not.toContain('private');
    expect(output).not.toContain('audio.mp3');
    expect(output).not.toContain('credential');
    expect(telemetry.fingerprint).toHaveBeenCalledWith(['voice.playback.failed', 'not_allowed']);
  });

  it.each([
    [1, 'aborted'],
    [2, 'network'],
    [3, 'decode'],
    [4, 'not_supported'],
  ])('handles media code %s and reloads existing audio on retry', (code, reason) => {
    const controller = attach();
    controller.toggle(1);
    player.error = { code: Number(code) };
    player.dispatchEvent(new Event('error'));
    player.dispatchEvent(new Event('error'));
    expect(failure).toHaveBeenLastCalledWith(reason);
    expect(failedLogs()).toHaveLength(1);
    controller.toggle(1);
    expect(player.load).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenLastCalledWith(null);
  });

  it('detects an error already set during metadata preload', () => {
    player.error = { code: 3 };
    attach();
    expect(failure).toHaveBeenCalledWith('decode');
    expect(failedLogs()[0]?.[2]).toMatchObject({ stage: 'preload', media_error_code: 3 });
  });

  it('deduplicates media failure and rejected play from the same attempt', async () => {
    let reject!: (error: Error) => void;
    player.play.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const controller = attach();
    controller.toggle(1);
    player.error = { code: 2 };
    player.dispatchEvent(new Event('error'));
    const rejectOldAttempt = reject;
    controller.toggle(1);
    rejectOldAttempt(new Error('old attempt'));
    await Promise.resolve();
    expect(failedLogs()).toHaveLength(1);
    expect(failure).toHaveBeenLastCalledWith(null);
  });

  it('handles a synchronous play exception and isolates telemetry errors', () => {
    telemetry.log.mockImplementation(() => {
      throw new Error('monitor unavailable');
    });
    player.play.mockImplementation(() => {
      throw new Error('private error');
    });
    const controller = attach();
    expect(() => controller.toggle(1)).not.toThrow();
    expect(failure).toHaveBeenLastCalledWith('other');
  });

  it('bounds warning issues by reason/minute without dropping per-attempt failure logs', async () => {
    player.play.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    const controller = attach();
    controller.toggle(1);
    await Promise.resolve();
    controller.toggle(1);
    await Promise.resolve();
    expect(failedLogs()).toHaveLength(2);
    expect(telemetry.capture).toHaveBeenCalledOnce();
  });
});

describe('voice playback lifecycle', () => {
  it('times out a pending play and ignores its eventual rejection', async () => {
    let reject!: (error: Error) => void;
    player.play.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    attach().toggle(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failure).toHaveBeenLastCalledWith('timeout');
    reject(new Error('late'));
    await Promise.resolve();
    expect(failedLogs()).toHaveLength(1);
  });

  it('resets the watchdog on real progress and records progress only once', async () => {
    attach().toggle(1);
    await vi.advanceTimersByTimeAsync(10_000);
    progress(1);
    await vi.advanceTimersByTimeAsync(10_000);
    progress(2);
    expect(failedLogs()).toHaveLength(0);
    expect(
      telemetry.log.mock.calls.filter(([, event]) => event === 'voice.playback.progress')
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failure).toHaveBeenLastCalledWith('timeout');
  });

  it('excludes background suspension and gives a fresh budget on return', async () => {
    attach().toggle(1);
    await vi.advanceTimersByTimeAsync(14_000);
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failedLogs()).toHaveLength(0);
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(failedLogs()).toHaveLength(0);
    progress(1);
    expect(failure).toHaveBeenLastCalledWith(null);
  });

  it('does not turn pause or another player taking over into failure', async () => {
    const controller = attach();
    controller.toggle(1);
    controller.toggle(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failedLogs()).toHaveLength(0);
    controller.toggle(1);
    const other = new Audio();
    attach(other).toggle(1);
    expect(player.paused).toBe(true);
    progress(3);
    expect(failedLogs()).toHaveLength(0);
  });

  it('does not report normal completion as cancellation or failure', () => {
    attach().toggle(1);
    progress(12);
    player.ended = true;
    player.pause();
    player.dispatchEvent(new Event('ended'));
    expect(telemetry.log.mock.calls.map(([, event]) => event)).toEqual([
      'voice.playback.started',
      'voice.playback.progress',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invalidates pending promises and removes listeners on source disposal', async () => {
    let reject!: (error: Error) => void;
    player.play.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const controller = attach();
    controller.toggle(1);
    controller.dispose();
    playing.mockClear();
    failure.mockClear();
    reject(new Error('old source'));
    player.error = { code: 3 };
    player.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(playing).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(failedLogs()).toHaveLength(0);
  });
});
