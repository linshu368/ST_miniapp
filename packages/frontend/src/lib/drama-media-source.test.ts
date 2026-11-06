import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/143.0 Mobile';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
/** Android WebView 的 canPlayType 对 HLS 也返回非空，这正是回归场景。 */
function nativeVideo() {
  return {
    src: '',
    currentSrc: '',
    canPlayType: () => 'maybe',
  } as unknown as HTMLVideoElement;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.attached = undefined;
});
afterEach(() => vi.unstubAllGlobals());
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
it('uses hls.js on Android even when the WebView claims native HLS support', async () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  const element = nativeVideo(),
    ready = vi.fn();
  const cleanup = loadDramaSource(element, playback, ready, vi.fn());
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  expect(element.src).toBe('blob:unit');
  cleanup();
});
it('keeps native HLS on iPhone', () => {
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  const element = nativeVideo(),
    ready = vi.fn();
  loadDramaSource(element, playback, ready, vi.fn());
  expect(element.src).toBe(playback.play_url);
  expect(ready).toHaveBeenCalledOnce();
  expect(state.created).not.toHaveBeenCalled();
});
