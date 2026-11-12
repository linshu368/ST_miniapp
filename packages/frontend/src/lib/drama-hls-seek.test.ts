import type HlsPlayer from 'hls.js';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HlsEvents } from '@/lib/perf/drama-hls';
import { restartStalledAudioOnSeek } from './drama-hls-seek';

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
