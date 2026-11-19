import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlazaVideoObserver } from './plaza-video-observer';
const reports = vi.hoisted(() => vi.fn());
vi.mock('@/lib/perf/plaza-metrics', () => ({ reportPlazaMetric: reports }));

class Video extends EventTarget {
  paused = true;
  seeking = false;
  readyState = 2;
  currentTime = 0;
  frames = new Map<number, () => void>();
  next = 0;
  requestVideoFrameCallback = (callback: () => void) => {
    this.frames.set(++this.next, callback);
    return this.next;
  };
  cancelVideoFrameCallback = (id: number) => this.frames.delete(id);
  event(name: string) {
    this.dispatchEvent(new Event(name));
  }
  present() {
    const pending = [...this.frames.values()];
    this.frames.clear();
    pending.forEach((run) => run());
  }
}
let now = 0;
let node: Video;
let observer: PlazaVideoObserver;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    run();
    return 1;
  });
  reports.mockClear();
  now = 100;
  node = new Video();
  observer = new PlazaVideoObserver(
    node as unknown as HTMLVideoElement,
    { route: '/create/work/:id', media: 'video' },
    vi.fn(),
    0,
    () => now
  );
});
afterEach(() => {
  observer.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('plaza real-frame observations', () => {
  it('does not count loadeddata or playing as first frame; duplicate callbacks settle once', () => {
    node.paused = false;
    node.event('play');
    node.event('loadeddata');
    node.event('playing');
    expect(reports.mock.calls.filter(([stage]) => stage === 'first_frame')).toHaveLength(0);
    now = 450;
    node.present();
    node.event('playing');
    node.present();
    expect(reports.mock.calls.filter(([stage]) => stage === 'first_frame')).toEqual([
      [
        'first_frame',
        'succeeded',
        350,
        expect.objectContaining({ measurement: 'video_frame_callback' }),
      ],
    ]);
  });
  it('observes paused seeks and ignores callbacks from a superseded seek', () => {
    node.event('seeking');
    node.currentTime = 5;
    node.event('seeked');
    now = 200;
    node.event('seeking');
    node.currentTime = 10;
    node.event('seeked');
    now = 500;
    node.present();
    expect(
      reports.mock.calls.filter(([stage, outcome]) => stage === 'seek' && outcome === 'succeeded')
    ).toHaveLength(1);
  });
  it('reports a background interruption and ignores late frames', () => {
    node.paused = false;
    node.event('play');
    vi.stubGlobal('document', { hidden: true });
    now = 300;
    observer.stop('background');
    node.present();
    expect(reports.mock.calls.filter(([stage]) => stage === 'first_frame')).toEqual([
      ['first_frame', 'background', 200, expect.any(Object)],
    ]);
  });
  it('times out observation without pausing the real player', () => {
    node.paused = false;
    node.event('play');
    now = 10100;
    vi.advanceTimersByTime(10000);
    node.present();
    expect(node.paused).toBe(false);
    expect(
      reports.mock.calls.filter(
        ([stage, outcome]) => stage === 'first_frame' && outcome === 'timeout'
      )
    ).toHaveLength(1);
    expect(
      reports.mock.calls.filter(
        ([stage, outcome]) => stage === 'first_frame' && outcome === 'succeeded'
      )
    ).toHaveLength(0);
  });
  it('falls back to advancing time plus frames, including paused seek', () => {
    observer.stop();
    reports.mockClear();
    const fallback = node as unknown as { requestVideoFrameCallback: undefined };
    fallback.requestVideoFrameCallback = undefined;
    observer = new PlazaVideoObserver(
      node as unknown as HTMLVideoElement,
      { route: '/create/work/:id' },
      vi.fn(),
      0,
      () => now
    );
    node.paused = false;
    node.event('play');
    node.event('playing');
    now = 500;
    node.currentTime = 0.2;
    node.event('timeupdate');
    expect(
      reports.mock.calls.filter(
        ([stage, outcome]) => stage === 'first_frame' && outcome === 'succeeded'
      )
    ).toHaveLength(1);
    node.paused = true;
    node.event('seeking');
    node.currentTime = 4;
    node.event('seeked');
    expect(
      reports.mock.calls.filter(([stage, outcome]) => stage === 'seek' && outcome === 'succeeded')
    ).toHaveLength(1);
  });
});
