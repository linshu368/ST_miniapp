import { beforeEach, expect, it, vi } from 'vitest';
import { loadDramaSource, ownsDramaSource } from './drama-media-source';
const state = vi.hoisted(() => ({
  destroyed: vi.fn(),
  created: vi.fn(),
  attached: undefined as (() => void) | undefined,
}));
vi.mock('hls.js', () => ({
  default: class {
    static Events = { ERROR: 'error', MEDIA_ATTACHED: 'attached' };
    static isSupported() {
      return true;
    }
    constructor() {
      state.created();
    }
    on(name: string, callback: () => void) {
      if (name === 'attached') state.attached = callback;
    }
    loadSource() {}
    attachMedia(video: HTMLVideoElement) {
      video.src = 'blob:unit';
    }
    destroy() {
      state.destroyed();
    }
  },
}));
function video() {
  return { src: '', currentSrc: '', canPlayType: () => '' } as unknown as HTMLVideoElement;
}
const playback = {
  video_id: null,
  playable: true,
  play_url: 'https://example.invalid/manifest',
  expires_at: null,
  format: 'hls' as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.attached = undefined;
});
it('does not attach a pending HLS import after a source was cancelled', async () => {
  const element = video(),
    ready = vi.fn();
  const cleanup = loadDramaSource(element, playback, ready, vi.fn());
  cleanup();
  await vi.waitFor(() => expect(ownsDramaSource(element, playback.play_url)).toBe(false));
  expect(ready).not.toHaveBeenCalled();
});
it('binds blob playback to the source generation and releases the instance', async () => {
  const element = video(),
    ready = vi.fn();
  const cleanup = loadDramaSource(element, playback, ready, vi.fn());
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  state.attached?.();
  expect(ready).toHaveBeenCalledOnce();
  expect(ownsDramaSource(element, playback.play_url)).toBe(true);
  cleanup();
  expect(state.destroyed).toHaveBeenCalledOnce();
  expect(ownsDramaSource(element, playback.play_url)).toBe(false);
});
