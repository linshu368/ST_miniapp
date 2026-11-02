'use client';

import Link from 'next/link';
import { discardPendingAction, startPendingAction } from '@/lib/perf/action-tracker';
import { usePageReady } from '@/lib/perf/page-ready';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  Copy,
  Heart,
  ImageIcon,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  IMAGE_PLAZA_FEED_STALE_TIME_MS,
  imagePlazaKeys,
  prefetchImagePlazaConfig,
  useCreateImagePlazaConversationMutation,
  useImagePlazaConfigQuery,
  useImagePlazaFeedQuery,
  useImagePlazaTagCountsQuery,
  useSetImagePlazaLikeMutation,
} from '@/lib/api/image-plaza';
import type { GetImagePlazaFeedData, ImagePlazaFeedSort, PlazaFeedItem } from '@miniapp/shared';
import { ImagePlazaHistorySheet } from '@/components/image-plaza/image-plaza-history-sheet';
import { StyleFilterSheet } from '@/components/image-plaza/style-filter-sheet';
import { markCriticalSettled } from '@/lib/entry-phase';
import { useMobilePerformancePolicy } from '@/lib/mobile-performance';
import { markPageCriticalVisual } from '@/lib/perf/page-tracker';
import { supabasePublicImageSrcSet, supabasePublicImageUrl } from '@/lib/supabase-image';
import {
  clearImagePlazaReturn,
  readImagePlazaReturn,
  restoreImagePlazaReturn,
  saveImagePlazaReturn,
} from '@/lib/image-plaza-return';

type NavigatorWithConnection = Navigator & {
  connection?: { saveData?: boolean; effectiveType?: string };
};

function canPrefetchWorkRoute(): boolean {
  if (document.visibilityState !== 'visible' || navigator.onLine === false) return false;
  const connection = (navigator as NavigatorWithConnection).connection;
  return (
    connection?.saveData !== true &&
    connection?.effectiveType !== 'slow-2g' &&
    connection?.effectiveType !== '2g'
  );
}

export default function CreatePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const performancePolicy = useMobilePerformancePolicy();
  const listBudget = performancePolicy.imagePlaza.list;
  const [returnSnapshot] = useState(() => readImagePlazaReturn());
  const restoring = useRef(returnSnapshot !== null);
  const [search, setSearch] = useState(returnSnapshot?.search ?? '');
  const [selectedTags, setSelectedTags] = useState<string[]>(
    returnSnapshot?.tags ??
      (returnSnapshot?.tag && returnSnapshot.tag !== 'all' ? [returnSnapshot.tag] : [])
  );
  const [media, setMedia] = useState<'all' | 'image' | 'video'>(returnSnapshot?.media ?? 'all');
  const [tags, setTags] = useState<GetImagePlazaFeedData['tags']>([
    {
      id: 'all',
      label: '全部',
      group_id: 'style',
      group_label: '风格',
      group_sort_order: 0,
      group_layout: 'chips',
      media_types: ['image', 'video'],
    },
  ]);
  const [sort, setSort] = useState<ImagePlazaFeedSort>(returnSnapshot?.sort ?? 'recommended');
  const [debouncedSearch, setDebouncedSearch] = useState(returnSnapshot?.search ?? '');
  const stableTags = useMemo(() => [...selectedTags].sort(), [selectedTags]);
  const feed = useImagePlazaFeedQuery(debouncedSearch, stableTags, sort, media);
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (feed.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [feed.data]);
  const [renderLimit, setRenderLimit] = useState(() =>
    returnSnapshot ? Number.POSITIVE_INFINITY : listBudget.initialRenderCount
  );
  const feedViewKey = useMemo(
    () => JSON.stringify([debouncedSearch, stableTags, sort, media]),
    [debouncedSearch, stableTags, sort, media]
  );
  const previousFeedViewKey = useRef(feedViewKey);
  useEffect(() => {
    if (previousFeedViewKey.current === feedViewKey) return;
    previousFeedViewKey.current = feedViewKey;
    setRenderLimit(listBudget.initialRenderCount);
  }, [feedViewKey, listBudget.initialRenderCount]);
  const renderedItems = useMemo(() => items.slice(0, renderLimit), [items, renderLimit]);
  const hasMoreToRender = renderedItems.length < items.length;
  const [criticalVisualSettled, setCriticalVisualSettled] = useState(false);
  const availableTags = useMemo(() => tags.filter((item) => item.id !== 'all'), [tags]);
  const tagCounts = useImagePlazaTagCountsQuery(
    debouncedSearch,
    media,
    availableTags.length > 0 && criticalVisualSettled
  );
  // 首批媒体结算后再预热工作室共用的模型配置。创建响应本身已写入 conversation
  // cache，因此用户点击进入时两份 P0 数据都能直接复用；失败仍由 Studio 原错误态承接。
  useImagePlazaConfigQuery({ enabled: criticalVisualSettled || feed.isError });
  useEffect(() => {
    if (criticalVisualSettled || feed.isError) markCriticalSettled();
  }, [criticalVisualSettled, feed.isError]);
  useEffect(() => {
    if (criticalVisualSettled || feed.data === undefined || feed.isError) return;
    // 媒体解码异常不能永久饿死标签计数和配置预热；旁路只放行后台工作，
    // critical visual 指标仍必须由真实 load/error/absent 结算。
    const timer = window.setTimeout(() => setCriticalVisualSettled(true), 1500);
    return () => window.clearTimeout(timer);
  }, [criticalVisualSettled, feed.data, feed.isError]);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = feed;
  const createConversation = useCreateImagePlazaConversationMutation();
  const sentinel = useRef<HTMLDivElement | null>(null);
  const pullStartY = useRef<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [pendingSourceWorkId, setPendingSourceWorkId] = useState<string | null>(null);

  useEffect(() => {
    if (!returnSnapshot) return;
    clearImagePlazaReturn();
    const cancelRestore = () => {
      restoring.current = false;
    };
    // Weak networks must not cause a delayed jump after the user has resumed browsing.
    const timer = window.setTimeout(cancelRestore, 2000);
    window.addEventListener('pointerdown', cancelRestore, { passive: true });
    window.addEventListener('wheel', cancelRestore, { passive: true });
    window.addEventListener('keydown', cancelRestore);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', cancelRestore);
      window.removeEventListener('wheel', cancelRestore);
      window.removeEventListener('keydown', cancelRestore);
    };
  }, [returnSnapshot]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const feedTags = feed.data?.pages[0]?.tags;

  useEffect(() => {
    // 筛选请求期间只保留标签栏，避免卸载后闪烁、丢失横向滚动位置；不复用旧作品或游标。
    if (!feedTags) return;
    setTags(feedTags);
    setSelectedTags((current) => current.filter((id) => feedTags.some((item) => item.id === id)));
  }, [feedTags]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      // 极老 WebView 保留完整列表能力；只是不再自动预取下一页。
      setRenderLimit(Number.POSITIVE_INFINITY);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // 先把已经拿到的数据渐进画出来，再请求下一页；否则短首屏会让 sentinel
        // 常驻视口并连续拉取多页，重新制造网络和解码突发。
        if (hasMoreToRender) {
          setRenderLimit((limit) => limit + listBudget.renderBatchSize);
          return;
        }
        if (
          hasNextPage &&
          !isFetchingNextPage &&
          !feed.paginationInvalidated &&
          !feed.isPlaceholderData &&
          !feed.isError &&
          !feed.isFetching
        )
          void fetchNextPage();
      },
      { rootMargin: listBudget.renderMoreRootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    fetchNextPage,
    hasMoreToRender,
    hasNextPage,
    isFetchingNextPage,
    listBudget.renderBatchSize,
    listBudget.renderMoreRootMargin,
    feed.paginationInvalidated,
    feed.isPlaceholderData,
    feed.isError,
    feed.isFetching,
  ]);

  usePageReady(
    '/create',
    feed.data !== undefined && (!feed.isError || items.length > 0),
    false,
    feed.isError
  );
  // 行优先分列：1 2 / 3 4，避免 CSS columns 的竖向填充（1 3 / 2 4）
  const feedColumns = useMemo(() => splitIntoColumns(renderedItems, 2), [renderedItems]);
  const criticalPreviewIds = useMemo(
    () => renderedItems.slice(0, 2).map((item) => item.id),
    [renderedItems]
  );
  const criticalPreviewKey = criticalPreviewIds.join(':');
  const criticalPreviews = useRef<{
    key: string;
    outcomes: Map<string, 'loaded' | 'error' | 'absent'>;
  }>({ key: '', outcomes: new Map() });
  if (criticalPreviews.current.key !== criticalPreviewKey) {
    criticalPreviews.current = { key: criticalPreviewKey, outcomes: new Map() };
  }
  const handleCriticalPreviewSettled = useCallback(
    (id: string, outcome: 'loaded' | 'error' | 'absent') => {
      if (!criticalPreviewIds.includes(id)) return;
      const state = criticalPreviews.current;
      if (state.key !== criticalPreviewKey || state.outcomes.has(id)) return;
      state.outcomes.set(id, outcome);
      if (state.outcomes.size !== criticalPreviewIds.length) return;
      const outcomes = [...state.outcomes.values()];
      setCriticalVisualSettled(true);
      markPageCriticalVisual(
        '/create',
        outcomes.includes('error') ? 'error' : outcomes.includes('loaded') ? 'loaded' : 'absent',
        undefined,
        feed.data !== undefined && feed.isFetching ? 'cache' : 'fetch'
      );
    },
    [criticalPreviewIds, criticalPreviewKey, feed.data, feed.isFetching]
  );
  useEffect(() => {
    if (feed.data === undefined || feed.isError || criticalPreviewIds.length > 0) return;
    setCriticalVisualSettled(true);
    markPageCriticalVisual('/create', 'absent', undefined, feed.isFetching ? 'cache' : 'fetch');
  }, [criticalPreviewIds.length, feed.data, feed.isError, feed.isFetching]);
  useEffect(() => {
    if (!feed.isError || items.length > 0) return;
    setCriticalVisualSettled(true);
    markPageCriticalVisual('/create', 'error', undefined, 'fetch');
  }, [feed.isError, items.length]);

  useLayoutEffect(() => {
    if (
      !returnSnapshot ||
      !restoring.current ||
      !feed.data ||
      feed.isFetching ||
      feed.paginationInvalidated
    )
      return;
    // The feed resets expired pagination in a passive effect; wait for its fresh first page
    // instead of restoring against cached cards that are about to disappear.
    if (Date.now() - feed.dataUpdatedAt > IMAGE_PLAZA_FEED_STALE_TIME_MS) return;
    restoreImagePlazaReturn(returnSnapshot);
    restoring.current = false;
  }, [returnSnapshot, feed.data, feed.dataUpdatedAt, feed.isFetching, feed.paginationInvalidated]);

  const saveReturn = (workId?: string) =>
    saveImagePlazaReturn({ search, tags: stableTags, media, sort }, workId);

  const startStudio = (sourceWorkId?: string) => {
    saveReturn(sourceWorkId);
    void prefetchImagePlazaConfig(queryClient);
    setPendingSourceWorkId(sourceWorkId ?? 'new');
    startPendingAction('create_conversation');
    createConversation.mutate(sourceWorkId ? { source_work_id: sourceWorkId } : {}, {
      onSuccess: ({ conversation }) => router.push(`/create/studio/${conversation.id}`),
      onError: () => {
        // 失败也算有了反馈（恢复按钮状态），不再计为「点了没反应」。
        discardPendingAction('create_conversation');
        clearImagePlazaReturn();
        setPendingSourceWorkId(null);
      },
    });
  };

  const refreshFeed = async () => {
    if (isPullRefreshing || feed.isFetchingNextPage) return;
    setIsPullRefreshing(true);
    try {
      await queryClient.resetQueries({
        queryKey: imagePlazaKeys.feed(debouncedSearch, stableTags, sort, media),
        exact: true,
      });
    } finally {
      setPullDistance(0);
      setIsPullRefreshing(false);
    }
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    pullStartY.current = window.scrollY <= 0 ? (event.touches[0]?.clientY ?? null) : null;
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLElement>) => {
    if (pullStartY.current === null) return;
    const delta = (event.touches[0]?.clientY ?? pullStartY.current) - pullStartY.current;
    setPullDistance(delta > 0 ? Math.min(96, delta * 0.45) : 0);
  };

  const handleTouchEnd = () => {
    pullStartY.current = null;
    if (pullDistance >= 64) void refreshFeed();
    else setPullDistance(0);
  };

  return (
    <main
      data-app-shell="image-plaza"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="mx-auto min-h-[calc(100dvh-var(--app-nav-space))] w-full max-w-screen-xl overscroll-y-contain bg-background text-foreground"
    >
      {pullDistance > 0 || isPullRefreshing ? (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-2 text-[11px] font-bold shadow-xl backdrop-blur-xl transition-transform"
          style={{ transform: `translate(-50%, ${isPullRefreshing ? 0 : pullDistance / 3}px)` }}
        >
          <RefreshCw className={`size-3.5 ${isPullRefreshing ? 'animate-spin' : ''}`} />
          {isPullRefreshing ? '正在刷新' : pullDistance >= 64 ? '松开刷新' : '下拉刷新'}
        </div>
      ) : null}
      <header
        data-image-plaza-header
        className="sticky top-0 z-30 border-b border-border/60 bg-background/90 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-xl"
      >
        <div className="flex items-center justify-between gap-1 min-[360px]:gap-3">
          <div className="flex min-w-0 shrink-0 items-center gap-1 min-[360px]:gap-2">
            <Link
              href="/creation"
              onClick={() => saveReturn()}
              aria-label="返回创作"
              title="返回创作"
              className="grid size-11 shrink-0 place-items-center rounded-full border border-white/[0.07] bg-white/[0.035] text-foreground/85 transition-colors active:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ChevronLeft className="size-[22px]" strokeWidth={1.8} aria-hidden />
            </Link>
            <h1 className="whitespace-nowrap text-base font-semibold leading-7 tracking-tight min-[360px]:text-xl">
              影像广场
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <ImagePlazaHistorySheet beforeNavigate={() => saveReturn()} />
            <button
              type="button"
              onClick={() => startStudio()}
              disabled={createConversation.isPending}
              className="inline-flex h-10 items-center gap-1 whitespace-nowrap rounded-full bg-primary px-2 text-xs font-bold text-primary-foreground disabled:opacity-60 min-[360px]:gap-1.5 min-[360px]:px-3 sm:px-4"
            >
              {createConversation.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              去创作
            </button>
          </div>
        </div>
        <div
          className="mt-2 grid grid-cols-3 rounded-xl bg-card p-1 ring-1 ring-border"
          role="group"
          aria-label="媒体类型"
        >
          {(['all', 'image', 'video'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={media === value}
              onClick={() => {
                setMedia(value);
              }}
              className={`min-h-9 rounded-lg text-xs font-bold ${media === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
            >
              {value === 'all' ? '全部' : value === 'image' ? '图片' : '视频'}
            </button>
          ))}
        </div>
        <label className="mt-2 flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-muted-foreground">
          <Search className="size-4" aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索作品灵感、图片内容"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="按作品灵感、内容搜索影像广场"
          />
        </label>
        <div className="mt-1 space-y-1">
          {tags.some((item) => item.id !== 'all') ? (
            <div
              className="flex min-w-0 items-center gap-2 py-1"
              role="group"
              aria-label="作品标签"
            >
              <div
                data-image-plaza-tags-scroll
                className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                <button
                  type="button"
                  aria-pressed={selectedTags.length === 0}
                  onClick={() => setSelectedTags([])}
                  className={`shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${selectedTags.length === 0 ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}`}
                >
                  不限
                </button>
                {availableTags.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selectedTags.includes(item.id)}
                    onClick={() =>
                      setSelectedTags((current) =>
                        current.length === 1 && current[0] === item.id ? [] : [item.id]
                      )
                    }
                    className={`relative shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${selectedTags.includes(item.id) ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}
                  >
                    {item.label}{' '}
                    <span className="text-xs font-normal opacity-70">
                      {tagCounts.isError ? '—' : (tagCounts.data?.counts[item.id] ?? '…')}
                    </span>
                  </button>
                ))}
              </div>
              <StyleFilterSheet
                tags={availableTags}
                selected={selectedTags}
                counts={tagCounts.data?.counts}
                countsFailed={tagCounts.isError}
                onChange={setSelectedTags}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2" role="group" aria-label="作品排序">
            {(['recommended', 'latest'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                onClick={() => {
                  setSort(value);
                  window.scrollTo({ top: 0, behavior: 'instant' });
                }}
                className={`relative shrink-0 whitespace-nowrap rounded-full border px-4 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${sort === value ? 'border-primary/30 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-card hover:text-foreground'}`}
              >
                {value === 'recommended' ? '推荐' : '最新'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="px-3 py-4">
        {feed.paginationInvalidated ? (
          <button
            type="button"
            onClick={() => void refreshFeed()}
            className="mb-3 w-full rounded-xl bg-card p-3 text-xs text-primary"
          >
            排序已更新，点击刷新后继续浏览
          </button>
        ) : null}
        {feed.isLoading ? (
          <FeedSkeleton />
        ) : feed.isError && items.length === 0 ? (
          <EmptyState
            icon={<ImageIcon />}
            title="广场暂时走丢了"
            action="重新加载"
            onAction={() => void feed.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<WandSparkles />}
            title={
              search || selectedTags.length || media !== 'all'
                ? '没有找到对应作品'
                : '还没有公开作品'
            }
            action={
              search || selectedTags.length || media !== 'all' ? '查看全部' : '生成第一个作品'
            }
            onAction={() => {
              if (search || selectedTags.length || media !== 'all') {
                setSearch('');
                setSelectedTags([]);
                setMedia('all');
              } else startStudio();
            }}
          />
        ) : (
          <div
            className={`grid grid-cols-2 items-start gap-3 ${
              feed.isPlaceholderData && feed.isFetching ? 'opacity-70 transition-opacity' : ''
            }`}
          >
            {feedColumns.map((column, columnIndex) => (
              <div key={columnIndex} className="flex min-w-0 flex-col gap-3">
                {column.map((work, rowIndex) => (
                  <PlazaCard
                    key={work.id}
                    work={work}
                    eager={columnIndex + rowIndex * 2 < listBudget.eagerImageCount}
                    priority={columnIndex + rowIndex * 2 < listBudget.highPriorityImageCount}
                    imageWidths={performancePolicy.imagePlaza.feedImageWidths}
                    imageQuality={performancePolicy.imagePlaza.feedImageQuality}
                    useSamePending={pendingSourceWorkId === work.id}
                    interactionDisabled={createConversation.isPending}
                    onPreviewSettled={handleCriticalPreviewSettled}
                    onPrefetch={() => {
                      if (canPrefetchWorkRoute()) router.prefetch(`/create/work/${work.id}`);
                    }}
                    onOpen={() => saveReturn(work.id)}
                    onUseSame={() => startStudio(work.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        <div
          ref={sentinel}
          className="flex h-16 items-center justify-center text-xs text-muted-foreground"
        >
          {feed.isError && items.length > 0 ? (
            <button type="button" onClick={() => void refreshFeed()}>
              加载失败，点击刷新后继续
            </button>
          ) : feed.isFetchingNextPage ? (
            <LoaderCircle className="size-5 animate-spin" />
          ) : hasMoreToRender ? (
            '继续下滑加载更多'
          ) : !feed.hasNextPage && items.length > 0 && !feed.isPlaceholderData ? (
            '已经到底啦'
          ) : null}
        </div>
      </section>
      {createConversation.isError ? (
        <p className="fixed bottom-[calc(var(--app-nav-space)+1rem)] left-1/2 z-50 -translate-x-1/2 rounded-full bg-destructive px-4 py-2 text-xs font-bold text-destructive-foreground">
          创建会话失败，请重试
        </p>
      ) : null}
    </main>
  );
}

function PlazaCard(props: {
  work: PlazaFeedItem;
  eager: boolean;
  priority: boolean;
  imageWidths: readonly number[];
  imageQuality: number;
  useSamePending: boolean;
  interactionDisabled: boolean;
  onPreviewSettled: (id: string, outcome: 'loaded' | 'error' | 'absent') => void;
  onPrefetch: () => void;
  onOpen: () => void;
  onUseSame: () => void;
}) {
  const like = useSetImagePlazaLikeMutation(props.work.id);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const previewUrl =
    props.work.media_type === 'video' ? props.work.poster_url : props.work.image_url;
  const aspectRatio =
    props.work.width > 0 && props.work.height > 0
      ? `${props.work.width} / ${props.work.height}`
      : '2 / 3';
  const previewRatio = {
    width: props.work.width > 0 ? props.work.width : 2,
    height: props.work.height > 0 ? props.work.height : 3,
  };
  const maxWidth = props.imageWidths[props.imageWidths.length - 1] ?? 480;
  const transformedPreviewUrl = previewUrl
    ? supabasePublicImageUrl(previewUrl, {
        width: maxWidth,
        height: Math.round((maxWidth * previewRatio.height) / previewRatio.width),
        quality: props.imageQuality,
      })
    : null;
  const transformedPreviewSrcSet = previewUrl
    ? supabasePublicImageSrcSet(previewUrl, props.imageWidths, previewRatio, {
        quality: props.imageQuality,
      })
    : undefined;
  const [useOriginalPreview, setUseOriginalPreview] = useState(false);
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const previewSettled = useRef(false);
  const displayPreviewUrl = useOriginalPreview ? previewUrl : transformedPreviewUrl;

  const settlePreview = (outcome: 'loaded' | 'error' | 'absent') => {
    if (previewSettled.current) return;
    previewSettled.current = true;
    props.onPreviewSettled(props.work.id, outcome);
  };

  useEffect(() => {
    setUseOriginalPreview(false);
    setImageState('loading');
    previewSettled.current = false;
    if (!previewUrl) {
      settlePreview('absent');
      return;
    }
    const node = imageRef.current;
    if (node?.complete && node.naturalWidth > 0) {
      setImageState('loaded');
      settlePreview('loaded');
    }
    // onPreviewSettled is deliberately not a dependency: the work URL owns this lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUrl]);

  const handlePreviewError = () => {
    if (
      previewUrl &&
      !useOriginalPreview &&
      transformedPreviewUrl &&
      transformedPreviewUrl !== previewUrl
    ) {
      setUseOriginalPreview(true);
      setImageState('loading');
      return;
    }
    setImageState('error');
    settlePreview('error');
  };

  return (
    <article
      data-image-work-id={props.work.id}
      className="group relative overflow-hidden rounded-[1.5rem] bg-card ring-1 ring-border/70"
    >
      {like.isError ? (
        <p
          role="alert"
          className="absolute inset-x-0 top-0 z-10 bg-destructive p-2 text-xs text-destructive-foreground"
        >
          点赞未确认，请刷新后重试
        </p>
      ) : null}
      <Link
        href={`/create/work/${props.work.id}`}
        prefetch={false}
        aria-label={`查看作品：${props.work.title}`}
        onPointerEnter={props.onPrefetch}
        onFocus={props.onPrefetch}
        onTouchStart={props.onPrefetch}
        onClick={props.onOpen}
        className="block"
      >
        <div className="relative w-full overflow-hidden bg-muted/50" style={{ aspectRatio }}>
          {imageState === 'loading' ? (
            <div aria-hidden className="absolute inset-0 animate-pulse bg-muted" />
          ) : null}
          {displayPreviewUrl && imageState !== 'error' ? (
            <img
              ref={imageRef}
              src={displayPreviewUrl}
              srcSet={useOriginalPreview ? undefined : transformedPreviewSrcSet}
              sizes="(max-width: 768px) calc(50vw - 18px), 300px"
              alt={props.work.title}
              width={props.work.width}
              height={props.work.height}
              loading={props.eager ? 'eager' : 'lazy'}
              fetchPriority={props.priority ? 'high' : 'auto'}
              decoding="async"
              onLoad={() => {
                setImageState('loaded');
                settlePreview('loaded');
              }}
              onError={handlePreviewError}
              className={`absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.02] ${
                imageState === 'loaded' ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center bg-muted text-muted-foreground">
              {props.work.media_type === 'video' ? (
                <Play className="size-8" aria-hidden />
              ) : (
                <ImageIcon className="size-8" aria-hidden />
              )}
            </div>
          )}
          {props.work.media_type === 'video' ? (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[10px] font-bold text-white">
              <Play className="size-3 fill-current" aria-hidden />
              {Math.ceil(props.work.duration_ms / 1000)}s
            </span>
          ) : null}
        </div>
      </Link>
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/90 via-black/35 to-transparent p-2 pt-16 text-white sm:p-3 sm:pt-16">
        <button
          type="button"
          disabled={like.isPending}
          onClick={() => like.mutate(!props.work.liked)}
          aria-label={
            props.work.liked ? `取消点赞：${props.work.title}` : `点赞：${props.work.title}`
          }
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full text-xs font-black drop-shadow-md disabled:opacity-60"
        >
          <Heart className={`size-4 ${props.work.liked ? 'fill-current' : ''}`} />
          {props.work.like_count}
        </button>
        <button
          type="button"
          disabled={props.interactionDisabled}
          onClick={props.onUseSame}
          aria-label={`用同款：${props.work.title}`}
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-black/45 px-2 text-[11px] font-black text-[#d8c1aa] shadow-lg backdrop-blur-md transition active:scale-95 sm:h-11 sm:gap-1.5 sm:px-3 sm:text-xs"
        >
          {props.useSamePending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Copy className="size-4" />
          )}
          {props.useSamePending ? '正在打开' : '用同款'}
        </button>
      </div>
    </article>
  );
}

function FeedSkeleton() {
  const ratios = ['2 / 3', '3 / 4', '1 / 1', '3 / 4', '2 / 3', '4 / 5', '2 / 3', '3 / 4'];
  const columns = splitIntoColumns(ratios, 2);
  return (
    <div className="grid grid-cols-2 items-start gap-3" aria-busy="true" aria-label="加载中">
      {columns.map((column, columnIndex) => (
        <div key={columnIndex} className="flex min-w-0 flex-col gap-3">
          {column.map((ratio, rowIndex) => (
            <div
              key={`${columnIndex}-${rowIndex}`}
              className="overflow-hidden rounded-[1.5rem] bg-muted/50 ring-1 ring-border/50"
            >
              <div className="w-full animate-pulse bg-muted" style={{ aspectRatio: ratio }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function splitIntoColumns<T>(items: readonly T[], columnCount: number): T[][] {
  const columns = Array.from({ length: columnCount }, () => [] as T[]);
  for (const [index, item] of items.entries()) {
    columns[index % columnCount]!.push(item);
  }
  return columns;
}

function EmptyState(props: {
  icon: React.ReactNode;
  title: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-[48vh] flex-col items-center justify-center gap-4 text-center text-muted-foreground">
      <div className="grid size-14 place-items-center rounded-full bg-card text-primary ring-1 ring-border">
        {props.icon}
      </div>
      <p className="text-sm font-bold text-foreground">{props.title}</p>
      <button
        type="button"
        onClick={props.onAction}
        className="rounded-full bg-primary px-5 py-2.5 text-xs font-black text-primary-foreground"
      >
        {props.action}
      </button>
    </div>
  );
}
