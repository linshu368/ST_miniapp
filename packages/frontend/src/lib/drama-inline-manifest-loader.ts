import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderResponse,
  LoaderStats,
  PlaylistLoaderContext,
  PlaylistLoaderConstructor,
} from 'hls.js';
import type { DramaPlaybackResources, DramaPrefetchUsage } from '@/lib/drama-playback-resources';

/**
 * 内联走的不是网络请求：start===end（耗时 0），不填 first（没有真实首字节）。
 * `recordHlsLoads` 的 `positive()` 判断非正数会自动省略 firstByteMs，
 * 消费方据此能和"恰好很快"的真实网络请求区分——配合诊断里的 manifestInline / prefetch 双重确认。
 */
function buildInlineStats(contentLength: number): LoaderStats {
  const now = performance.now();
  return {
    aborted: false,
    loaded: contentLength,
    retry: 0,
    total: contentLength,
    chunkCount: 1,
    bwEstimate: 0,
    loading: { start: now, first: 0, end: now },
    parsing: { start: now, end: now },
    buffering: { start: now, first: 0, end: now },
  };
}

/** 播放资源缓存：子清单按绝对 URL 命中，usage 记录实际从缓存应答的数量和字节。 */
export interface PlaylistCache {
  resources: DramaPlaybackResources;
  usage: DramaPrefetchUsage;
}

const isChildPlaylist = (context: PlaylistLoaderContext) =>
  context.type === 'level' || context.type === 'audioTrack';

/**
 * 只拦截两类 playlist 请求，其它所有请求原样转发到 hls.js 当前配置的真实网络 loader
 * （`config.loader`；pLoader 只服务 manifest/level/audioTrack/subtitleTrack 这类 playlist 请求）：
 * - 主清单、地址等于 matchUrl、且有内联内容：直接用内联内容应答。
 * - 子清单（level/audioTrack）、URL 在缓存里：等预取结果（预取失败就转发到网络）；
 *   不在缓存里的走网络，成功后回写缓存，供往回滑和回到同一部复用。
 */
export function createInlinePlaylistLoader(
  matchUrl: string,
  content: string | undefined,
  cache?: PlaylistCache
): PlaylistLoaderConstructor {
  return class InlinePlaylistLoader implements Loader<PlaylistLoaderContext> {
    // hls.js 的 config.loader 类型是 Loader<LoaderContext>（通用形状）；真实实现
    // （XhrLoader/FetchLoader）对 context 的具体字段并不挑剔，这里转发时按实际可用的
    // 更具体类型处理，只在构造这一处做一次有意识的类型断言。
    private readonly delegate: Loader<PlaylistLoaderContext>;
    private aborted = false;
    private cachedInlineContext: PlaylistLoaderContext | null = null;
    private cachedInlineStats: LoaderStats | null = null;

    constructor(config: HlsConfig) {
      this.delegate = new config.loader(config) as unknown as Loader<PlaylistLoaderContext>;
    }

    get context(): PlaylistLoaderContext | null {
      return this.cachedInlineStats ? this.cachedInlineContext : this.delegate.context;
    }

    get stats(): LoaderStats {
      return this.cachedInlineStats ?? this.delegate.stats;
    }

    load(
      context: PlaylistLoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<PlaylistLoaderContext>
    ): void {
      this.aborted = false;
      this.cachedInlineStats = null;
      this.cachedInlineContext = null;
      if (content !== undefined && context.type === 'manifest' && context.url === matchUrl) {
        // 延后一个微任务触发，和真实网络 loader 的异步时序保持一致，
        // 不在 load() 同一个调用栈里就触发下游处理。
        queueMicrotask(() => this.respond(context, content, callbacks));
        return;
      }
      const pending =
        cache && isChildPlaylist(context) ? cache.resources.playlists.get(context.url) : undefined;
      if (pending) {
        void pending.then((text) => {
          if (this.aborted) return;
          if (text === undefined) return this.forward(context, config, callbacks);
          cache!.usage.playlists += 1;
          cache!.usage.bytes += text.length;
          this.respond(context, text, callbacks);
        });
        return;
      }
      this.forward(context, config, callbacks);
    }

    private respond(
      context: PlaylistLoaderContext,
      data: string,
      callbacks: LoaderCallbacks<PlaylistLoaderContext>
    ): void {
      if (this.aborted) return;
      const stats = buildInlineStats(data.length);
      this.cachedInlineStats = stats;
      this.cachedInlineContext = context;
      const response: LoaderResponse = { url: context.url, data };
      callbacks.onSuccess(response, stats, context, null);
    }

    private forward(
      context: PlaylistLoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<PlaylistLoaderContext>
    ): void {
      if (!cache || !isChildPlaylist(context))
        return this.delegate.load(context, config, callbacks);
      const playlists = cache.resources.playlists;
      this.delegate.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          if (typeof response.data === 'string' && !playlists.has(ctx.url))
            playlists.set(ctx.url, Promise.resolve(response.data));
          callbacks.onSuccess(response, stats, ctx, networkDetails);
        },
      });
    }

    abort(): void {
      this.aborted = true;
      this.delegate.abort();
    }

    destroy(): void {
      this.aborted = true;
      this.delegate.destroy();
    }

    getCacheAge(): number | null {
      return this.delegate.getCacheAge ? this.delegate.getCacheAge() : null;
    }

    getResponseHeader(name: string): string | null {
      return this.delegate.getResponseHeader ? this.delegate.getResponseHeader(name) : null;
    }
  };
}
