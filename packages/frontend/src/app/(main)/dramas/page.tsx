'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

import { useDramaListQuery } from '@/lib/api/drama';
import { useDramaStreamWarmth } from '@/hooks/use-connection-warmth';
import { selectDramas } from '@/lib/drama-catalog';
import { clearFeedReturn, peekFeedReturn } from '@/lib/drama-feed-return';
import { DramaListHeader, DramaGridSkeleton } from '@/components/drama/drama-list-shell';
import { DramaLibraryTab } from '@/components/drama/drama-library-tab';
import {
  ContinueWatching,
  DramaCard,
  EmptyState,
  FeedStrip,
  revealDramaCard,
} from '@/components/drama/drama-theater-cards';
import { markCriticalSettled } from '@/lib/entry-phase';
import { dramaTiming } from '@/lib/perf/drama-observer';
import { useFreshAfterFetch, usePageReady } from '@/lib/perf/page-ready';
import { markPageCriticalVisual } from '@/lib/perf/page-tracker';
import { cn } from '@/lib/utils';
import { useMobilePerformancePolicy } from '@/lib/mobile-performance';
import { useDramaLibraryStore, useHydrateDramaLibrary } from '@/stores/drama-library-store';

const CATEGORIES = ['全部', '悬疑', '恋爱', '古风', '科幻', '喜剧', '治愈', '脑洞'];
const APPROXIMATE_CARD_ROW_HEIGHT = 300;
const RESTORE_TAIL_COUNT = 12;

export default function DramasPage() {
  useDramaStreamWarmth();
  const performancePolicy = useMobilePerformancePolicy();
  const listBudget = performancePolicy.dramas;
  const { data, isLoading, isError, isFetching, refetch } = useDramaListQuery();
  const hydrated = useHydrateDramaLibrary();
  const fresh = useFreshAfterFetch(isFetching, data !== undefined, isError);
  usePageReady(
    '/dramas',
    hydrated && data !== undefined && !isError,
    fresh,
    isError,
    data !== undefined && isFetching ? 'cache' : fresh ? 'fetch' : 'unknown'
  );
  const browse = useDramaLibraryStore((state) => state.browse);
  const setBrowse = useDramaLibraryStore((state) => state.setBrowse);
  const history = useDramaLibraryStore((state) => state.history);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 从放映返回：放映按点击时的列表连播，这里找回最后看的那部并标出来。
  const [returnFocus] = useState(peekFeedReturn);
  const pendingFocus = useRef(returnFocus);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(clearFeedReturn, []);
  const focusSearch = useRef(false);
  const restoreSearchScroll = useRef<number | null>(null);
  const dramas = data ?? [];
  const searching = Boolean(browse.keyword.trim());
  const visibleDramas = selectDramas(
    dramas,
    browse.keyword,
    searching ? '全部' : browse.category,
    browse.sort
  );
  const [renderLimit, setRenderLimit] = useState(listBudget.initialRenderCount);
  // Detail return restores scrollTop immediately, so mount the target rows plus one-screen tail.
  const restoreFloor =
    searching || browse.scroll <= 0
      ? 0
      : Math.ceil(Math.max(0, browse.scroll) / APPROXIMATE_CARD_ROW_HEIGHT) * 2 +
        RESTORE_TAIL_COUNT;
  const focusIndex = returnFocus
    ? visibleDramas.findIndex((drama) => drama.id === returnFocus)
    : -1;
  const focusFloor = focusIndex < 0 ? 0 : focusIndex + 1 + RESTORE_TAIL_COUNT;
  const effectiveRenderLimit = Math.max(renderLimit, restoreFloor, focusFloor);
  const renderedDramas = visibleDramas.slice(0, effectiveRenderLimit);
  const hasMoreToRender = renderedDramas.length < visibleDramas.length;
  const criticalPosterIds = renderedDramas.slice(0, 2).map((drama) => drama.id);
  const criticalPosterKey = criticalPosterIds.join(':');
  const criticalPosters = useRef<{
    key: string;
    outcomes: Map<string, 'loaded' | 'error' | 'absent'>;
  }>({ key: '', outcomes: new Map() });
  if (criticalPosters.current.key !== criticalPosterKey) {
    criticalPosters.current = { key: criticalPosterKey, outcomes: new Map() };
  }
  const handleCriticalPosterSettled = useCallback(
    (id: string, outcome: 'loaded' | 'error' | 'absent') => {
      if (!criticalPosterIds.includes(id)) return;
      const state = criticalPosters.current;
      if (state.key !== criticalPosterKey || state.outcomes.has(id)) return;
      state.outcomes.set(id, outcome);
      if (state.outcomes.size !== criticalPosterIds.length) return;
      const outcomes = [...state.outcomes.values()];
      markPageCriticalVisual(
        '/dramas',
        outcomes.includes('error') ? 'error' : outcomes.includes('loaded') ? 'loaded' : 'absent',
        undefined,
        data !== undefined && isFetching ? 'cache' : 'fetch'
      );
    },
    [criticalPosterIds, criticalPosterKey, data, isFetching]
  );
  useEffect(() => {
    if (data !== undefined && !isError && criticalPosterIds.length === 0) {
      markPageCriticalVisual('/dramas', 'absent', undefined, isFetching ? 'cache' : 'fetch');
    }
  }, [criticalPosterIds.length, data, isError, isFetching]);
  const recent = dramas
    .filter((drama) => history[drama.id])
    .sort((a, b) => (history[b.id]?.updatedAt ?? 0) - (history[a.id]?.updatedAt ?? 0));
  // 试看仍可在「最近看过」找到，但不能挤掉用户正在追的故事。
  const continuing = recent
    .filter((drama) => {
      const progress = history[drama.id]!;
      return !progress.completed && (progress.engagedAt === undefined || progress.engagedAt > 0);
    })
    .sort((a, b) => {
      const first = history[a.id]!;
      const second = history[b.id]!;
      return (second.engagedAt ?? second.updatedAt) - (first.engagedAt ?? first.updatedAt);
    });
  const latest = continuing[0];

  useEffect(() => {
    if (data !== undefined || isError) markCriticalSettled();
    if (data) dramaTiming.listReady(data);
    else if (isError) dramaTiming.listFailed();
  }, [data, isError]);

  useEffect(() => {
    if (browse.tab !== 'theater' || !hydrated) return;
    const scrollElement = scrollRef.current;
    if (scrollElement) scrollElement.scrollTop = useDramaLibraryStore.getState().browse.scroll;
    const focus = pendingFocus.current;
    if (focus && scrollElement && revealDramaCard(scrollElement, focus)) {
      pendingFocus.current = null;
      setFlashId(focus);
    }
    if (focusSearch.current) {
      searchRef.current?.focus();
      focusSearch.current = false;
    }
    return () => {
      if (scrollElement)
        useDramaLibraryStore.getState().setBrowse({ scroll: scrollElement.scrollTop });
    };
  }, [browse.tab, hydrated, isLoading]);

  useEffect(() => {
    if (!searching && restoreSearchScroll.current !== null) {
      if (scrollRef.current) scrollRef.current.scrollTop = restoreSearchScroll.current;
      restoreSearchScroll.current = null;
    }
  }, [searching]);

  const rememberScroll = () => {
    if (browse.tab === 'theater') setBrowse({ scroll: scrollRef.current?.scrollTop ?? 0 });
  };
  const switchTab = (tab: typeof browse.tab) => {
    rememberScroll();
    setBrowse({ tab });
  };
  const openSearch = () => {
    focusSearch.current = true;
    switchTab('theater');
    if (browse.tab === 'theater') searchRef.current?.focus();
  };
  const filter = (patch: Partial<typeof browse>) => {
    setRenderLimit(listBudget.initialRenderCount);
    setBrowse({ ...patch, scroll: 0 });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const updateKeyword = (keyword: string) => {
    const enteringSearch = !searching && Boolean(keyword.trim());
    const leavingSearch = searching && !keyword.trim();
    const scroll = leavingSearch ? (browse.searchReturnScroll ?? 0) : 0;
    setRenderLimit(listBudget.initialRenderCount);
    if (leavingSearch) restoreSearchScroll.current = scroll;
    setBrowse({
      keyword,
      scroll,
      searchReturnScroll: enteringSearch
        ? (scrollRef.current?.scrollTop ?? 0)
        : leavingSearch
          ? null
          : browse.searchReturnScroll,
    });
    if (scrollRef.current) scrollRef.current.scrollTop = scroll;
  };
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!hasMoreToRender || !node) return;
    const grow = () => setRenderLimit((limit) => limit + listBudget.renderBatchSize);
    if (typeof IntersectionObserver === 'undefined') {
      setRenderLimit(Number.POSITIVE_INFINITY);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) grow();
      },
      { rootMargin: listBudget.renderMoreRootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreToRender, effectiveRenderLimit, listBudget]);
  const retry = () => {
    dramaTiming.beginList('retry');
    void refetch();
  };

  return (
    <main
      className="fixed inset-0 z-30 overflow-hidden bg-[#121113] text-[#eee7e2]"
      aria-label="短剧"
    >
      <div
        ref={browse.tab === 'theater' ? scrollRef : undefined}
        aria-label={browse.tab === 'theater' ? '短剧列表' : undefined}
        className={cn(
          'mx-auto max-w-lg',
          browse.tab === 'theater'
            ? 'absolute inset-x-0 bottom-[var(--app-nav-space)] top-[env(safe-area-inset-top)] overflow-y-auto overscroll-contain [scrollbar-width:none]'
            : 'relative h-full'
        )}
      >
        <DramaListHeader tab={browse.tab} onTabChange={switchTab} onSearch={openSearch} />

        {isLoading || !hydrated ? (
          <DramaGridSkeleton />
        ) : isError ? (
          <EmptyState
            title="短剧暂时没加载出来"
            detail="网络可能开了个小差，再试一次就好。"
            action="重新加载"
            onAction={retry}
          />
        ) : !dramas.length ? (
          <EmptyState
            title="好戏，即将开场"
            detail="短剧正在陆续上架，稍后回来看看。"
            action="刷新看看"
            onAction={retry}
          />
        ) : browse.tab === 'theater' ? (
          <>
            <div className="sticky top-0 z-20 bg-[#121113] px-4 py-2">
              <div
                role="search"
                className="relative flex h-11 items-center rounded-xl bg-white/[0.065]"
              >
                <Search aria-hidden className="ml-3 h-[18px] w-[18px] shrink-0 text-[#eee7e2]/40" />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="搜索短剧名称或题材"
                  placeholder="搜剧名，找你想看的故事"
                  value={browse.keyword}
                  maxLength={100}
                  onChange={(event) => updateKeyword(event.target.value)}
                  className="h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-[#eee7e2] outline-none placeholder:text-[#eee7e2]/35 [&::-webkit-search-cancel-button]:hidden"
                />
                {browse.keyword ? (
                  <button
                    type="button"
                    aria-label="清除搜索"
                    onClick={() => updateKeyword('')}
                    className="flex h-11 w-11 items-center justify-center"
                  >
                    <X className="h-4 w-4 text-[#eee7e2]/60" />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="px-4 pb-6">
              {searching ? null : <FeedStrip dramas={dramas} onOpen={rememberScroll} />}
              {searching ? (
                <div className="mt-2 flex min-h-11 items-center justify-between text-xs">
                  <span className="text-[#eee7e2]/45">全部短剧中搜索</span>
                  <button
                    type="button"
                    onClick={() => updateKeyword('')}
                    className="-mr-2 min-h-11 px-2 text-[#c4a0a7]"
                  >
                    退出搜索
                  </button>
                </div>
              ) : (
                <div
                  aria-label="短剧分类"
                  className="-mx-4 mt-2 flex overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {CATEGORIES.map((category) => (
                    <button
                      key={category}
                      type="button"
                      aria-pressed={browse.category === category}
                      onClick={() => filter({ category })}
                      className={cn(
                        'mr-1 min-h-11 shrink-0 px-3 text-sm',
                        browse.category === category
                          ? 'font-semibold text-[#eee7e2]'
                          : 'text-[#eee7e2]/55'
                      )}
                    >
                      {category}
                    </button>
                  ))}
                </div>
              )}
              {latest && history[latest.id] && !searching && browse.category === '全部' ? (
                <ContinueWatching
                  drama={latest}
                  progress={history[latest.id]!}
                  queue={continuing}
                  onOpen={rememberScroll}
                />
              ) : null}
              <div className="mb-1 mt-0 flex items-center justify-between gap-2">
                <h1 className="text-sm font-medium text-[#eee7e2]/75">
                  {searching
                    ? '搜索结果'
                    : browse.category === '全部'
                      ? '发现好剧'
                      : `${browse.category}剧场`}
                </h1>
                <div className="flex text-xs">
                  {(['recommended', 'latest'] as const).map((sort) => (
                    <button
                      key={sort}
                      type="button"
                      aria-pressed={browse.sort === sort}
                      onClick={() => filter({ sort })}
                      className={cn(
                        'min-h-11 px-2',
                        browse.sort === sort ? 'font-medium text-[#eee7e2]' : 'text-[#eee7e2]/40'
                      )}
                    >
                      {sort === 'recommended' ? '精选' : '最新'}
                    </button>
                  ))}
                </div>
              </div>
              {visibleDramas.length ? (
                <div className="grid grid-cols-2 gap-3">
                  {renderedDramas.map((drama, index) => (
                    <DramaCard
                      key={drama.id}
                      drama={drama}
                      queue={visibleDramas}
                      progress={history[drama.id]}
                      onOpen={rememberScroll}
                      eager={index < listBudget.eagerImageCount}
                      priority={index < listBudget.highPriorityImageCount}
                      flash={drama.id === flashId}
                      onPosterSettled={index < 2 ? handleCriticalPosterSettled : undefined}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="还没找到这部剧"
                  detail="换个名字，或试试其他题材。"
                  action={searching ? '返回剧场' : '清除筛选'}
                  onAction={() => (searching ? updateKeyword('') : filter({ category: '全部' }))}
                />
              )}
              {hasMoreToRender ? <div ref={loadMoreRef} aria-hidden className="h-px" /> : null}
              {visibleDramas.length && !hasMoreToRender ? (
                <p className="pb-2 pt-8 text-center text-[11px] text-[#eee7e2]/30">
                  找个故事，慢慢入戏
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <DramaLibraryTab
            dramas={dramas}
            recent={recent}
            onDiscover={() => switchTab('theater')}
          />
        )}
      </div>
    </main>
  );
}
