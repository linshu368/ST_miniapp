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

/**
 * 内联走的不是网络请求：start===end（耗时 0），不填 first（没有真实首字节）。
 * `recordHlsLoads` 的 `positive()` 判断非正数会自动省略 firstByteMs，
 * 消费方据此能和"恰好很快"的真实网络请求区分——配合诊断里的 manifestInline 字段双重确认。
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

/**
 * 只拦截"主清单请求、地址等于 matchUrl"这一种情况，直接用内联内容应答；
 * 其它所有请求（子清单、分片、不匹配的 manifest 请求）原样转发到 hls.js 当前配置的
 * 真实网络 loader（`config.loader`，对子清单/分片同样有效，因为 pLoader 只服务
 * manifest/level/audioTrack/subtitleTrack 这类 playlist 请求）。
 */
export function createInlinePlaylistLoader(
  matchUrl: string,
  content: string
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
      if (context.type === 'manifest' && context.url === matchUrl) {
        this.aborted = false;
        const stats = buildInlineStats(content.length);
        this.cachedInlineStats = stats;
        this.cachedInlineContext = context;
        const response: LoaderResponse = { url: matchUrl, data: content };
        // 延后一个微任务触发，和真实网络 loader 的异步时序保持一致，
        // 不在 load() 同一个调用栈里就触发下游处理。
        queueMicrotask(() => {
          if (this.aborted) return;
          callbacks.onSuccess(response, stats, context, null);
        });
        return;
      }
      this.cachedInlineStats = null;
      this.cachedInlineContext = null;
      this.delegate.load(context, config, callbacks);
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
