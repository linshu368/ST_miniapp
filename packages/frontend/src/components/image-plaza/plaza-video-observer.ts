import type { VideoPlazaPlaybackObservation } from '@miniapp/shared';
import {
  reportPlazaMetric,
  type PlazaDimensions,
  type PlazaOutcome,
  type PlazaStage,
} from '@/lib/perf/plaza-metrics';

type Stage = VideoPlazaPlaybackObservation['stage'];
type Report = (
  stage: Stage,
  outcome: VideoPlazaPlaybackObservation['outcome'],
  duration: number,
  count?: number
) => void;
type Pending = { start: number; timer: ReturnType<typeof setTimeout> };

/** One artifact owner; callbacks and watchdogs are cancelled together on source disposal. */
export class PlazaVideoObserver {
  private disposed = false;
  private first?: Pending;
  private seek?: Pending;
  private firstSettled = false;
  private played = false;
  private prepared = false;
  private seeks = 0;
  private stallStart?: number;
  private stallMs = 0;
  private stalls = 0;
  private frames = new Set<number>();
  private fallbacks = new Set<() => void>();
  private listeners: Array<[string, EventListener]> = [];
  private readonly method: PlazaDimensions['measurement'];
  private prepareTimeout: ReturnType<typeof setTimeout>;
  private failed = false;
  constructor(
    private node: HTMLVideoElement,
    private dimensions: PlazaDimensions,
    private send: Report,
    private entryStart = performance.now(),
    private now = () => performance.now()
  ) {
    this.prepareTimeout = setTimeout(() => {
      if (!this.prepared && !this.disposed) {
        this.prepared = true;
        this.metric('video_prepare', 'timeout', this.entryStart);
      }
    }, 10_000);
    this.method =
      typeof node.requestVideoFrameCallback === 'function'
        ? 'video_frame_callback'
        : 'playing_and_timeupdate';
    this.on('loadeddata', () => this.prepare());
    this.on('play', () => this.play());
    this.on('playing', () => {
      if (this.stallStart !== undefined) this.frame(() => this.endStall());
      this.requestFirstFrame();
    });
    this.on('seeking', () => this.startSeek());
    this.on('seeked', () => this.completeSeek());
    this.on('waiting', () => {
      if (
        this.firstSettled &&
        !this.node.paused &&
        !this.node.seeking &&
        this.stallStart === undefined
      ) {
        this.stallStart = this.now();
        this.stalls++;
      }
    });
    this.on('pause', () => {
      this.endStall();
      this.finishFirst(document.hidden ? 'background' : 'paused');
    });
    this.on('ended', () => this.endStall());
    if (node.readyState >= 2) this.prepare();
  }
  private on(name: string, run: () => void) {
    const listener = () => {
      if (!this.disposed) run();
    };
    this.node.addEventListener(name, listener);
    this.listeners.push([name, listener]);
  }
  private metric(stage: PlazaStage, outcome: PlazaOutcome, start: number) {
    reportPlazaMetric(stage, outcome, Math.max(0, this.now() - start), {
      ...this.dimensions,
      measurement: this.method,
    });
  }
  private prepare() {
    if (this.prepared) return;
    this.prepared = true;
    clearTimeout(this.prepareTimeout);
    reportPlazaMetric('video_prepare', 'succeeded', Math.max(0, this.now() - this.entryStart), {
      ...this.dimensions,
      measurement: 'media_ready',
    });
  }
  private pending(fail: () => void): Pending {
    return { start: this.now(), timer: setTimeout(fail, 10_000) };
  }
  private play() {
    if (this.played) return;
    this.played = true;
    this.first = this.pending(() => this.finishFirst('timeout'));
    this.requestFirstFrame();
  }
  private requestFirstFrame() {
    const pending = this.first;
    if (!pending || this.node.paused || this.node.seeking) return;
    this.frame(() => {
      if (this.first !== pending || this.node.paused || this.node.seeking) return;
      this.finishFirst('succeeded');
      this.metric('entry_first_frame', 'succeeded', this.entryStart);
    });
  }
  private finishFirst(outcome: PlazaOutcome) {
    if (!this.first) return;
    const pending = this.first;
    this.first = undefined;
    clearTimeout(pending.timer);
    this.firstSettled = outcome === 'succeeded';
    this.metric('first_frame', outcome, pending.start);
    this.send(
      'first_frame',
      outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'interrupted',
      this.now() - pending.start
    );
  }
  private startSeek() {
    this.endStall();
    if (this.seek) this.finishSeek('interrupted');
    if (this.seeks++ >= 4) return;
    this.seek = this.pending(() => this.finishSeek('timeout'));
  }
  private completeSeek() {
    const pending = this.seek;
    const target = this.node.currentTime;
    if (!pending) return;
    this.frame(() => {
      if (
        this.seek !== pending ||
        this.node.seeking ||
        Math.abs(this.node.currentTime - target) > 1
      )
        return;
      this.finishSeek('succeeded');
    }, true);
  }
  private finishSeek(outcome: PlazaOutcome) {
    if (!this.seek) return;
    const pending = this.seek;
    this.seek = undefined;
    clearTimeout(pending.timer);
    this.metric('seek', outcome, pending.start);
    this.send(
      'seek',
      outcome === 'succeeded' ? 'succeeded' : outcome === 'failed' ? 'failed' : 'interrupted',
      this.now() - pending.start
    );
  }
  private frame(run: () => void, pausedSeek = false) {
    if (this.method === 'video_frame_callback') {
      const handle = this.node.requestVideoFrameCallback(() => {
        this.frames.delete(handle);
        if (!this.disposed && !document.hidden) run();
      });
      this.frames.add(handle);
    } else {
      // A frame opportunity plus advancing media time; seeked permits a paused target frame.
      const before = this.node.currentTime;
      const confirm = () => {
        if (this.disposed || document.hidden || this.node.readyState < 2) return;
        if (!pausedSeek && this.node.currentTime <= before) return;
        this.node.removeEventListener('timeupdate', confirm);
        this.fallbacks.delete(confirm);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (!this.disposed && !document.hidden) run();
          })
        );
      };
      this.fallbacks.add(confirm);
      this.node.addEventListener('timeupdate', confirm);
      if (pausedSeek) confirm();
    }
  }
  private endStall() {
    if (this.stallStart === undefined) return;
    this.stallMs += Math.max(0, this.now() - this.stallStart);
    this.stallStart = undefined;
  }
  fail() {
    if (this.failed || this.disposed) return;
    this.failed = true;
    clearTimeout(this.prepareTimeout);
    if (!this.first && !this.seek)
      this.metric(this.firstSettled ? 'rebuffer' : 'video_prepare', 'failed', this.entryStart);
    this.prepared = true;
    this.finishFirst('failed');
    this.finishSeek('failed');
  }
  stop(outcome: 'left' | 'background' | 'interrupted' = 'left') {
    if (this.disposed) return;
    this.finishFirst(outcome);
    this.finishSeek(outcome);
    this.endStall();
    if (!this.prepared) this.metric('video_prepare', outcome, this.entryStart);
    if (this.stalls) {
      reportPlazaMetric(
        'rebuffer',
        'succeeded',
        this.stallMs,
        {
          ...this.dimensions,
          measurement: this.method,
        },
        this.stalls
      );
      this.send('stall', 'succeeded', this.stallMs, this.stalls);
    }
    this.disposed = true;
    clearTimeout(this.prepareTimeout);
    this.listeners.forEach(([event, listener]) => this.node.removeEventListener(event, listener));
    this.frames.forEach((handle) => this.node.cancelVideoFrameCallback(handle));
    this.fallbacks.forEach((listener) => this.node.removeEventListener('timeupdate', listener));
  }
}
