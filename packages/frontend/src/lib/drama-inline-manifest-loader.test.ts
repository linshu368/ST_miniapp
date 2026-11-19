import { describe, expect, it, vi } from 'vitest';
import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  PlaylistLoaderContext,
} from 'hls.js';
import { createInlinePlaylistLoader, type PlaylistCache } from './drama-inline-manifest-loader';

const MATCH_URL = 'https://customer-unit.cloudflarestream.com/token/manifest/video.m3u8';
const OTHER_URL = 'https://customer-unit.cloudflarestream.com/other-token/manifest/video.m3u8';
const CONTENT = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlevel0/main.m3u8\n';

class FakeDelegate {
  context: LoaderContext | null = null;
  stats = {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
  loadCalls: LoaderContext[] = [];
  loadCallbacks: LoaderCallbacks<LoaderContext>[] = [];
  abortCalls = 0;
  destroyCalls = 0;
  load(context: LoaderContext, _config: unknown, callbacks: LoaderCallbacks<LoaderContext>) {
    this.loadCalls.push(context);
    this.loadCallbacks.push(callbacks);
  }
  abort() {
    this.abortCalls++;
  }
  destroy() {
    this.destroyCalls++;
  }
  getCacheAge() {
    return 42;
  }
  getResponseHeader(name: string) {
    return name === 'age' ? '7' : null;
  }
}

function fakeConfig(): HlsConfig {
  return { loader: FakeDelegate } as unknown as HlsConfig;
}

function manifestContext(url: string): PlaylistLoaderContext {
  return {
    url,
    type: 'manifest',
    responseType: 'text',
    level: null,
    id: null,
    deliveryDirectives: null,
    levelOrTrack: null,
  } as unknown as PlaylistLoaderContext;
}

function levelContext(url: string): PlaylistLoaderContext {
  return { ...manifestContext(url), type: 'level' } as PlaylistLoaderContext;
}

function fakeCallbacks(): LoaderCallbacks<PlaylistLoaderContext> {
  return { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() };
}

describe('createInlinePlaylistLoader', () => {
  it('manifest 且地址匹配时直接用内联内容应答，不转发到真实 loader', async () => {
    const InlineLoader = createInlinePlaylistLoader(MATCH_URL, CONTENT);
    const instance = new InlineLoader(fakeConfig());
    const callbacks = fakeCallbacks();
    const context = manifestContext(MATCH_URL);

    instance.load(context, {} as LoaderConfiguration, callbacks);
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
    const [response, stats, calledContext, networkDetails] = (
      callbacks.onSuccess as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(response).toEqual({ url: MATCH_URL, data: CONTENT });
    expect(calledContext).toBe(context);
    expect(networkDetails).toBeNull();
    expect(stats.loading.start).toBe(stats.loading.end);
    expect(stats.loading.first).toBe(0);
    expect(stats.total).toBe(CONTENT.length);
    expect(instance.context).toBe(context);
    expect(instance.stats).toBe(stats);
  });

  it('manifest 但地址不匹配时转发到真实网络 loader', async () => {
    const InlineLoader = createInlinePlaylistLoader(MATCH_URL, CONTENT);
    const config = fakeConfig();
    const instance = new InlineLoader(config);
    const callbacks = fakeCallbacks();
    const context = manifestContext(OTHER_URL);

    instance.load(context, {} as LoaderConfiguration, callbacks);
    await Promise.resolve();

    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    // 构造时 new config.loader(config) 创建的就是 FakeDelegate 实例；
    // 这里通过类型断言拿到底层委托来断言转发发生了。
    const delegate = (instance as unknown as { delegate: FakeDelegate }).delegate;
    expect(delegate.loadCalls).toEqual([context]);
  });

  it('level/audioTrack/subtitleTrack 即使地址等于 matchUrl 也转发到真实 loader', async () => {
    const InlineLoader = createInlinePlaylistLoader(MATCH_URL, CONTENT);
    const instance = new InlineLoader(fakeConfig());
    const callbacks = fakeCallbacks();
    const context = levelContext(MATCH_URL);

    instance.load(context, {} as LoaderConfiguration, callbacks);
    await Promise.resolve();

    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    const delegate = (instance as unknown as { delegate: FakeDelegate }).delegate;
    expect(delegate.loadCalls).toEqual([context]);
  });

  it('abort 在内联回调触发前调用时，不应答也不残留状态，并转发 abort 给真实 loader', async () => {
    const InlineLoader = createInlinePlaylistLoader(MATCH_URL, CONTENT);
    const instance = new InlineLoader(fakeConfig());
    const callbacks = fakeCallbacks();
    const context = manifestContext(MATCH_URL);

    instance.load(context, {} as LoaderConfiguration, callbacks);
    instance.abort();
    await Promise.resolve();

    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    const delegate = (instance as unknown as { delegate: FakeDelegate }).delegate;
    expect(delegate.abortCalls).toBe(1);
  });

  it('destroy 转发给真实 loader', () => {
    const InlineLoader = createInlinePlaylistLoader(MATCH_URL, CONTENT);
    const instance = new InlineLoader(fakeConfig());
    instance.destroy();
    const delegate = (instance as unknown as { delegate: FakeDelegate }).delegate;
    expect(delegate.destroyCalls).toBe(1);
  });

  it('getCacheAge/getResponseHeader 转发给真实 loader', () => {
    const InlineLoader = createInlinePlaylistLoader(MATCH_URL, CONTENT);
    const instance = new InlineLoader(fakeConfig());
    expect(instance.getCacheAge?.()).toBe(42);
    expect(instance.getResponseHeader?.('age')).toBe('7');
    expect(instance.getResponseHeader?.('other')).toBeNull();
  });

  it('非内联请求后，context/stats 来自真实 loader，不是上一次内联缓存的残留', async () => {
    const InlineLoader = createInlinePlaylistLoader(MATCH_URL, CONTENT);
    const instance = new InlineLoader(fakeConfig());
    const delegate = (instance as unknown as { delegate: FakeDelegate }).delegate;
    const callbacks = fakeCallbacks();
    instance.load(manifestContext(MATCH_URL), {} as LoaderConfiguration, callbacks);
    await Promise.resolve();
    expect(instance.context).not.toBeNull();

    delegate.context = levelContext(OTHER_URL);
    instance.load(levelContext(OTHER_URL), {} as LoaderConfiguration, callbacks);
    expect(instance.context).toBe(delegate.context);
    expect(instance.stats).toBe(delegate.stats);
  });
});

const CHILD_URL = 'https://customer-unit.cloudflarestream.com/token/manifest/stream_240.m3u8';
const CHILD = '#EXTM3U\n#EXTINF:4,\nseg0.mp4\n';

function cacheWith(entries: Array<[string, string | undefined]>): PlaylistCache {
  return {
    resources: { playlists: new Map(entries.map(([url, text]) => [url, Promise.resolve(text)])) },
    usage: { playlists: 0, bytes: 0 },
  };
}

const delegateOf = (instance: object) =>
  (instance as unknown as { delegate: FakeDelegate }).delegate;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createInlinePlaylistLoader 播放资源缓存', () => {
  it('子清单 URL 命中缓存：直接应答、不发网络请求，并计入 usage', async () => {
    const cache = cacheWith([[CHILD_URL, CHILD]]);
    const instance = new (createInlinePlaylistLoader(MATCH_URL, CONTENT, cache))(fakeConfig());
    const callbacks = fakeCallbacks();
    instance.load(levelContext(CHILD_URL), {} as LoaderConfiguration, callbacks);
    await flush();

    expect(delegateOf(instance).loadCalls).toEqual([]);
    const [response, stats] = (callbacks.onSuccess as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(response).toEqual({ url: CHILD_URL, data: CHILD });
    expect(stats.loading.first).toBe(0);
    expect(cache.usage).toEqual({ playlists: 1, bytes: CHILD.length });
  });

  it('预取失败（结果为空）：转发到真实网络，不计入 usage', async () => {
    const cache = cacheWith([[CHILD_URL, undefined]]);
    const instance = new (createInlinePlaylistLoader(MATCH_URL, undefined, cache))(fakeConfig());
    const context = levelContext(CHILD_URL);
    instance.load(context, {} as LoaderConfiguration, fakeCallbacks());
    await flush();

    expect(delegateOf(instance).loadCalls).toEqual([context]);
    expect(cache.usage.playlists).toBe(0);
  });

  it('URL 不在缓存：走网络，成功后回写缓存，供下次命中', async () => {
    const cache = cacheWith([]);
    const instance = new (createInlinePlaylistLoader(MATCH_URL, undefined, cache))(fakeConfig());
    const callbacks = fakeCallbacks();
    const context = levelContext(CHILD_URL);
    instance.load(context, {} as LoaderConfiguration, callbacks);
    const delegate = delegateOf(instance);
    expect(delegate.loadCalls).toEqual([context]);

    delegate.loadCallbacks[0]!.onSuccess(
      { url: CHILD_URL, data: CHILD },
      delegate.stats,
      context,
      null
    );
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
    await expect(cache.resources.playlists.get(CHILD_URL)).resolves.toBe(CHILD);
  });

  it('等待预取结果期间被 abort：不应答也不转发', async () => {
    const cache = cacheWith([[CHILD_URL, CHILD]]);
    const instance = new (createInlinePlaylistLoader(MATCH_URL, CONTENT, cache))(fakeConfig());
    const callbacks = fakeCallbacks();
    instance.load(levelContext(CHILD_URL), {} as LoaderConfiguration, callbacks);
    instance.abort();
    await flush();

    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(delegateOf(instance).loadCalls).toEqual([]);
  });

  it('没有内联主清单时，主清单请求照常走网络', async () => {
    const instance = new (createInlinePlaylistLoader(MATCH_URL, undefined, cacheWith([])))(
      fakeConfig()
    );
    const context = manifestContext(MATCH_URL);
    instance.load(context, {} as LoaderConfiguration, fakeCallbacks());
    expect(delegateOf(instance).loadCalls).toEqual([context]);
  });
});
