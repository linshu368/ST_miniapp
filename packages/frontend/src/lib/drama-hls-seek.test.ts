import type HlsPlayer from 'hls.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HlsEvents } from '@/lib/perf/drama-hls';
import { prepareDramaSeek } from './drama-media-source';
import { createHlsSeekPlanner, restartStalledAudioOnSeek } from './drama-hls-seek';

const events = {
  FRAG_LOADING: 'loading',
  FRAG_LOADED: 'loaded',
  FRAG_BUFFERED: 'buffered',
  MEDIA_ATTACHED: 'attached',
} as unknown as HlsEvents;

type Listener = (event: unknown, data: unknown) => void;

function fakeHls() {
  const listeners = new Map<string, Set<Listener>>();
  const hls = {
    on: (name: string, fn: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    off: (name: string, fn: Listener) => listeners.get(name)?.delete(fn),
    stopLoad: vi.fn(),
    startLoad: vi.fn(),
  };
  const emit = (name: string, data?: unknown) =>
    listeners.get(name)?.forEach((fn) => fn(name, data));
  return { hls, emit };
}

function fakeVideo(buffered: Array<[number, number]> = []) {
  const target = new EventTarget();
  return Object.assign(target, {
    currentTime: 0,
    buffered: {
      length: buffered.length,
      start: (i: number) => buffered[i]![0],
      end: (i: number) => buffered[i]![1],
    },
  });
}

const audio = (sn: number, start: number) => ({ type: 'audio', sn, start, duration: 4 });
const main = (sn: number, start: number) => ({ type: 'main', sn, start, duration: 4 });

let h: ReturnType<typeof fakeHls>;
let video: ReturnType<typeof fakeVideo>;

function setup(buffered: Array<[number, number]> = []) {
  h = fakeHls();
  video = fakeVideo(buffered);
  const stop = restartStalledAudioOnSeek(
    h.hls as unknown as HlsPlayer,
    events,
    video as unknown as HTMLVideoElement
  );
  h.emit('attached');
  return stop;
}

function seek(to: number) {
  video.currentTime = to;
  video.dispatchEvent(new Event('seeking'));
}

beforeEach(() => vi.clearAllMocks());

it('restarts loading once when a stalled audio fragment does not cover an unbuffered target', () => {
  setup([[0, 10]]);
  h.emit('loaded', { frag: audio(3, 12) });
  seek(70);
  expect(h.hls.stopLoad).toHaveBeenCalledTimes(1);
  expect(h.hls.startLoad).toHaveBeenCalledWith(70, true);
  // 同一挂起状态只重启一次（拖动期间会连续触发 seeking）。
  seek(71);
  expect(h.hls.stopLoad).toHaveBeenCalledTimes(1);
});

it('does nothing when the target is already buffered', () => {
  setup([[0, 80]]);
  h.emit('loaded', { frag: audio(3, 12) });
  seek(70);
  expect(h.hls.stopLoad).not.toHaveBeenCalled();
});

it('does nothing when only main fragments are loaded', () => {
  setup();
  h.emit('loaded', { frag: main(3, 12) });
  seek(70);
  expect(h.hls.stopLoad).not.toHaveBeenCalled();
});

it('does nothing once the audio fragment has been buffered', () => {
  setup();
  const frag = audio(3, 12);
  h.emit('loaded', { frag });
  h.emit('buffered', { frag });
  seek(70);
  expect(h.hls.stopLoad).not.toHaveBeenCalled();
});

it('does nothing when the stalled audio fragment covers the target', () => {
  setup();
  h.emit('loaded', { frag: audio(17, 68) });
  seek(70);
  expect(h.hls.stopLoad).not.toHaveBeenCalled();
});

it('forgets the stalled fragment once a newer audio load starts', () => {
  setup();
  h.emit('loaded', { frag: audio(3, 12) });
  h.emit('loading', { frag: audio(4, 16) });
  seek(70);
  expect(h.hls.stopLoad).not.toHaveBeenCalled();
});

it('ignores init segments', () => {
  setup();
  h.emit('loaded', { frag: { type: 'audio', sn: 'initSegment', start: 0, duration: 0 } });
  seek(70);
  expect(h.hls.stopLoad).not.toHaveBeenCalled();
});

it('stops reacting after cleanup', () => {
  const stop = setup();
  h.emit('loaded', { frag: audio(3, 12) });
  stop();
  seek(70);
  expect(h.hls.stopLoad).not.toHaveBeenCalled();
});

it('swallows player errors so seeking keeps working', () => {
  setup();
  h.hls.stopLoad.mockImplementation(() => {
    throw new Error('destroyed');
  });
  h.emit('loaded', { frag: audio(3, 12) });
  expect(() => seek(70)).not.toThrow();
});

describe('createHlsSeekPlanner', () => {
  // Stream 实测档位峰值码率（bps），4s 一片。
  const BITRATES = [360_000, 580_000, 720_000, 1_430_000, 2_930_000];
  const fragments = Array.from({ length: 10 }, (_, sn) => ({ sn, start: sn * 4, duration: 4 }));
  function plannerHls(overrides: Record<string, unknown> = {}) {
    const { hls: emitter, emit } = fakeHls();
    return {
      on: emitter.on,
      off: emitter.off,
      emit,
      levels: BITRATES.map((maxBitrate) => ({ maxBitrate, details: { fragments } })),
      currentLevel: 4,
      loadLevel: 4,
      autoLevelEnabled: true,
      minAutoLevel: 0,
      maxAutoLevel: 4,
      bandwidthEstimate: 6_000_000,
      nextAutoLevel: 4,
      audioTracks: [] as Array<{ details?: { fragments: typeof fragments } }>,
      audioTrack: -1,
      ...overrides,
    };
  }
  // Stream 实测：独立音频分片起点比视频晚约 0.2s。
  const audioFragments = Array.from({ length: 10 }, (_, sn) => ({
    sn,
    start: sn * 4 + 0.2,
    duration: 4,
  }));
  const withAudio = (fragmentsOfAudio = audioFragments) =>
    plannerHls({ audioTracks: [{ details: { fragments: fragmentsOfAudio } }], audioTrack: 0 });
  function plan(
    hls: ReturnType<typeof plannerHls>,
    target: number,
    buffered: Array<[number, number]> = []
  ) {
    const media = Object.assign(fakeVideo(buffered), { duration: 40 });
    const planner = createHlsSeekPlanner(
      hls as unknown as HlsPlayer,
      plannerEvents,
      media as unknown as HTMLVideoElement
    );
    return planner.plan(target);
  }
  const plannerEvents = {
    FRAG_LOADED: 'loaded',
    FRAG_BUFFERED: 'buffered',
  } as unknown as HlsEvents;

  it('snaps a target in the last 20% of a fragment to the next fragment start', () => {
    expect(plan(plannerHls(), 23.5)).toBeCloseTo(24.05);
    expect(plan(plannerHls(), 22.5)).toBe(22.5);
  });

  it('keeps moving past the audio tail after snapping to a video fragment', () => {
    // 23.5 → 视频吸附到 24.05，落在音频 sn5 [20.2, 24.2) 末尾 → 音频 sn6 起点 +0.05。
    expect(plan(withAudio(), 23.5)).toBeCloseTo(24.25);
  });

  it('snaps out of an audio tail even when the video position is fine', () => {
    expect(plan(withAudio(), 24.1)).toBeCloseTo(24.25);
    expect(plan(withAudio(), 22.5)).toBe(22.5);
  });

  it('stays put when the audio tail has no following fragment', () => {
    expect(plan(withAudio(audioFragments.slice(0, 6)), 24.1)).toBe(24.1);
  });

  it('snaps on video only when there is no separate audio track', () => {
    const audioWithoutDetails = plannerHls({ audioTracks: [{}], audioTrack: 0 });
    expect(plan(audioWithoutDetails, 23.5)).toBeCloseTo(24.05);
    expect(plan(plannerHls(), 24.1)).toBe(24.1);
  });

  it('does not snap inside the last fragment', () => {
    expect(plan(plannerHls(), 39.5)).toBe(39.5);
  });

  it('leaves buffered targets and the ABR level untouched', () => {
    const hls = plannerHls({ bandwidthEstimate: 500_000 });
    expect(plan(hls, 23.5, [[20, 30]])).toBe(23.5);
    expect(hls.nextAutoLevel).toBe(4);
  });

  it('forces the lowest level when there is no bandwidth estimate', () => {
    const hls = plannerHls({ bandwidthEstimate: Number.NaN });
    plan(hls, 10);
    expect(hls.nextAutoLevel).toBe(0);
  });

  it('forces the highest loaded level that downloads one fragment within 1s', () => {
    const hls = plannerHls();
    plan(hls, 10);
    // 2.93Mbps×4s/6Mbps≈1.95s 超预算；1.43Mbps≈0.95s 在预算内。
    expect(hls.nextAutoLevel).toBe(3);
    const withoutDetails = plannerHls();
    withoutDetails.levels[3] = { maxBitrate: BITRATES[3]!, details: undefined as never };
    plan(withoutDetails, 10);
    expect(withoutDetails.nextAutoLevel).toBe(2);
  });

  it('does not raise the level ABR already picked', () => {
    const hls = plannerHls({ nextAutoLevel: 1 });
    plan(hls, 10);
    expect(hls.nextAutoLevel).toBe(1);
  });

  it('keeps the forced level until the planned fragment is buffered', () => {
    const hls = plannerHls({ bandwidthEstimate: Number.NaN });
    plan(hls, 10);
    // 10s 落在 sn 2。ABR 在该片加载成功后清除强制值；入缓冲前必须再强制一次。
    hls.nextAutoLevel = 4;
    hls.emit('loaded', { frag: { type: 'main', level: 0, sn: 2 } });
    expect(hls.nextAutoLevel).toBe(0);
    // 邻近分片（含同档位）入缓冲不能提前解除，否则 ABR 会把目标片换高档重下。
    hls.emit('buffered', { frag: { type: 'main', level: 4, sn: 1 } });
    hls.emit('buffered', { frag: { type: 'main', level: 0, sn: 1 } });
    hls.nextAutoLevel = 4;
    hls.emit('loaded', { frag: { type: 'main', level: 0, sn: 2 } });
    expect(hls.nextAutoLevel).toBe(0);
    hls.emit('buffered', { frag: { type: 'main', level: 0, sn: 2 } });
    hls.nextAutoLevel = 4;
    hls.emit('loaded', { frag: { type: 'main', level: 0, sn: 2 } });
    expect(hls.nextAutoLevel).toBe(4);
  });

  it('does not pin when nothing was forced', () => {
    const hls = plannerHls({ nextAutoLevel: 0 });
    plan(hls, 10);
    hls.nextAutoLevel = 2;
    hls.emit('loaded', { frag: { type: 'main', level: 0 } });
    expect(hls.nextAutoLevel).toBe(2);
  });

  it('returns the original target when hls.js state throws', () => {
    const hls = plannerHls();
    Object.defineProperty(hls, 'levels', {
      get: () => {
        throw new Error('destroyed');
      },
    });
    expect(plan(hls, 23.5)).toBe(23.5);
  });

  it('keeps native playback targets unchanged', () => {
    expect(prepareDramaSeek(fakeVideo() as unknown as HTMLVideoElement, 23.5)).toBe(23.5);
  });
});
