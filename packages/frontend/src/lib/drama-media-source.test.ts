import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { capAppleHlsQuality, loadDramaSource, ownsDramaSource } from './drama-media-source';
const state = vi.hoisted(() => ({
  destroyed: vi.fn(),
  created: vi.fn(),
  attached: undefined as ((data?: { mediaSource?: unknown }) => void) | undefined,
  order: [] as string[],
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
    on(name: string, callback: (event: string, data?: { mediaSource?: unknown }) => void) {
      if (name === 'attached') state.attached = (data) => callback('attached', data);
    }
    loadSource() {
      state.order.push('loadSource');
    }
    attachMedia(video: HTMLVideoElement) {
      state.order.push('attachMedia');
      video.src = 'blob:unit';
    }
    destroy() {
      state.destroyed();
    }
  },
}));
/** 测试里的最小 ManagedMediaSource 替身；只用于 instanceof 判断，不实现真实接口。 */
class FakeManagedMediaSource {}
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
  state.order = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
it('uses hls.js on Android even when the WebView claims native HLS support', async () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  const element = nativeVideo(),
    ready = vi.fn();
  const cleanup = loadDramaSource(element, playback, ready, vi.fn());
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  expect(element.src).toBe('blob:unit');
  cleanup();
});
it('lets diagnostics subscribe before the manifest loads and never blocks playback', async () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  const ready = vi.fn();
  const onHls = vi.fn(() => {
    state.order.push('observe');
    throw new Error('diagnostic failure');
  });
  const cleanup = loadDramaSource(video(), playback, ready, vi.fn(), onHls);
  await vi.waitFor(() => expect(onHls).toHaveBeenCalledOnce());
  state.attached?.();
  expect(state.order).toEqual(['observe', 'attachMedia', 'loadSource']);
  expect(ready).toHaveBeenCalledOnce();
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
it('caps Apple HLS quality with a bandwidth hint on the playback URL', () => {
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  expect(capAppleHlsQuality(playback).play_url).toBe(
    'https://example.invalid/manifest?clientBandwidthHint=2.5'
  );
  expect(
    capAppleHlsQuality({ ...playback, play_url: 'https://example.invalid/m?a=1' }).play_url
  ).toBe('https://example.invalid/m?a=1&clientBandwidthHint=2.5');
});
it('leaves Android, MP4 and unplayable results untouched', () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  expect(capAppleHlsQuality(playback)).toBe(playback);
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  const mp4 = { ...playback, format: 'mp4' as const };
  expect(capAppleHlsQuality(mp4)).toBe(mp4);
  const none = { ...playback, playable: false, play_url: null };
  expect(capAppleHlsQuality(none)).toBe(none);
});
it('stays on native HLS on iPhone when the flag is on but ManagedMediaSource is unavailable', () => {
  vi.stubEnv('NEXT_PUBLIC_DRAMA_IOS_HLSJS', 'true');
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  const element = nativeVideo(),
    ready = vi.fn();
  loadDramaSource(element, playback, ready, vi.fn());
  expect(element.src).toBe(playback.play_url);
  expect(state.created).not.toHaveBeenCalled();
  expect(capAppleHlsQuality(playback).play_url).toBe(
    'https://example.invalid/manifest?clientBandwidthHint=2.5'
  );
});
it('routes iPhone to hls.js when the flag is on and ManagedMediaSource exists, without the 720p cap', async () => {
  vi.stubEnv('NEXT_PUBLIC_DRAMA_IOS_HLSJS', 'true');
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  vi.stubGlobal('window', { ManagedMediaSource: FakeManagedMediaSource });
  expect(capAppleHlsQuality(playback)).toBe(playback);
  const element = nativeVideo(),
    ready = vi.fn(),
    onEngine = vi.fn();
  const cleanup = loadDramaSource(element, playback, ready, vi.fn(), undefined, onEngine);
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  state.attached?.({ mediaSource: new FakeManagedMediaSource() });
  expect(onEngine).toHaveBeenCalledWith('hlsjs_mms');
  expect(ready).toHaveBeenCalledOnce();
  cleanup();
});
it('tags the engine as hlsjs_mse when hls.js attaches a plain MediaSource', async () => {
  vi.stubEnv('NEXT_PUBLIC_DRAMA_IOS_HLSJS', 'true');
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  vi.stubGlobal('window', { ManagedMediaSource: FakeManagedMediaSource });
  const onEngine = vi.fn();
  const cleanup = loadDramaSource(nativeVideo(), playback, vi.fn(), vi.fn(), undefined, onEngine);
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  state.attached?.({ mediaSource: {} });
  expect(onEngine).toHaveBeenCalledWith('hlsjs_mse');
  cleanup();
});
it('reports native_file and native_hls through onEngine on the synchronous branches', () => {
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  const onEngine = vi.fn();
  loadDramaSource(nativeVideo(), playback, vi.fn(), vi.fn(), undefined, onEngine);
  expect(onEngine).toHaveBeenCalledWith('native_hls');
  const mp4 = { ...playback, format: 'mp4' as const };
  const onEngineMp4 = vi.fn();
  loadDramaSource(nativeVideo(), mp4, vi.fn(), vi.fn(), undefined, onEngineMp4);
  expect(onEngineMp4).toHaveBeenCalledWith('native_file');
});
