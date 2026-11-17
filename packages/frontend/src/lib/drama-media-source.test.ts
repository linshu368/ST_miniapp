import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  alignResumeSeconds,
  capAppleHlsQuality,
  loadDramaSource,
  ownsDramaSource,
  resolveResumeTarget,
} from './drama-media-source';
import { createInlinePlaylistLoader } from './drama-inline-manifest-loader';
const state = vi.hoisted(() => ({
  destroyed: vi.fn(),
  created: vi.fn(),
  attached: undefined as ((data?: { mediaSource?: unknown }) => void) | undefined,
  order: [] as string[],
  lastConfig: undefined as Record<string, unknown> | undefined,
}));
vi.mock('./drama-inline-manifest-loader', () => ({
  createInlinePlaylistLoader: vi.fn(() => 'fake-ploader-sentinel'),
}));
vi.mock('hls.js', () => ({
  default: class {
    static Events = { ERROR: 'error', MEDIA_ATTACHED: 'attached' };
    static isSupported() {
      return true;
    }
    constructor(config: Record<string, unknown>) {
      state.created();
      state.lastConfig = config;
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
  state.lastConfig = undefined;
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
  const cleanup = loadDramaSource(element, playback, ready, vi.fn(), undefined, { onEngine });
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
  const cleanup = loadDramaSource(nativeVideo(), playback, vi.fn(), vi.fn(), undefined, {
    onEngine,
  });
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  state.attached?.({ mediaSource: {} });
  expect(onEngine).toHaveBeenCalledWith('hlsjs_mse');
  cleanup();
});
it('reports native_file and native_hls through onEngine on the synchronous branches', () => {
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
  const onEngine = vi.fn();
  loadDramaSource(nativeVideo(), playback, vi.fn(), vi.fn(), undefined, { onEngine });
  expect(onEngine).toHaveBeenCalledWith('native_hls');
  const mp4 = { ...playback, format: 'mp4' as const };
  const onEngineMp4 = vi.fn();
  loadDramaSource(nativeVideo(), mp4, vi.fn(), vi.fn(), undefined, { onEngine: onEngineMp4 });
  expect(onEngineMp4).toHaveBeenCalledWith('native_file');
});
it('aligns resume seconds to the 4s Stream fragment boundary only for hls', () => {
  expect(alignResumeSeconds(12.0, 'hls')).toBe(12);
  expect(alignResumeSeconds(13.9, 'hls')).toBe(12);
  expect(alignResumeSeconds(0, 'hls')).toBe(0);
  expect(alignResumeSeconds(13.9, 'mp4')).toBe(13.9);
  expect(alignResumeSeconds(13.9, undefined)).toBe(13.9);
});
it('resolves the resume target: near-ending restarts from zero on non-exact resume only', () => {
  expect(resolveResumeTarget({ seconds: 119.6, duration: 120, exact: false, format: 'hls' })).toBe(
    0
  );
  expect(resolveResumeTarget({ seconds: 119.6, duration: 120, exact: true, format: 'hls' })).toBe(
    119.6
  );
});
it('resolves the resume target: hls aligns on the non-exact path, mp4 and exact stay precise', () => {
  expect(resolveResumeTarget({ seconds: 13.9, duration: 120, exact: false, format: 'hls' })).toBe(
    12
  );
  expect(resolveResumeTarget({ seconds: 13.9, duration: 120, exact: true, format: 'hls' })).toBe(
    13.9
  );
  expect(resolveResumeTarget({ seconds: 13.9, duration: 120, exact: false, format: 'mp4' })).toBe(
    13.9
  );
  expect(resolveResumeTarget({ seconds: 130, duration: 120, exact: true, format: 'hls' })).toBe(
    120
  );
});
it('passes the resume startPosition into the hls.js config', async () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  const cleanup = loadDramaSource(video(), playback, vi.fn(), vi.fn(), undefined, {
    startPosition: 12,
  });
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  expect(state.lastConfig?.startPosition).toBe(12);
  cleanup();
});
it('defaults startPosition to -1 (hls.js automatic) when none is given', async () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  const cleanup = loadDramaSource(video(), playback, vi.fn(), vi.fn());
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  expect(state.lastConfig?.startPosition).toBe(-1);
  cleanup();
});
it('builds a pLoader from inline_manifest and passes it into the Hls config', async () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  const inlinePlayback = { ...playback, inline_manifest: '#EXTM3U\n...' };
  const cleanup = loadDramaSource(video(), inlinePlayback, vi.fn(), vi.fn());
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  expect(createInlinePlaylistLoader).toHaveBeenCalledWith(
    inlinePlayback.play_url,
    inlinePlayback.inline_manifest
  );
  expect(state.lastConfig?.pLoader).toBe('fake-ploader-sentinel');
  cleanup();
});
it('omits pLoader when the backend did not provide inline_manifest', async () => {
  vi.stubGlobal('navigator', { userAgent: ANDROID_UA });
  const cleanup = loadDramaSource(video(), playback, vi.fn(), vi.fn());
  await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
  expect(createInlinePlaylistLoader).not.toHaveBeenCalled();
  expect(state.lastConfig?.pLoader).toBeUndefined();
  cleanup();
});
