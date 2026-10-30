'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bookmark, Check, ChevronRight, Clapperboard, Clock3, Play, Search, X } from 'lucide-react';
import type { DramaSummary } from '@miniapp/shared';

import { useDramaListQuery, usePrefetchDramaPlayback } from '@/lib/api/drama';
import { selectDramas } from '@/lib/drama-catalog';
import { DramaListHeader, DramaGridSkeleton } from '@/components/drama/drama-list-shell';
import { markCriticalSettled } from '@/lib/entry-phase';
import { dramaTiming, coverLoadMs } from '@/lib/perf/drama-observer';
import { useFreshAfterFetch, usePageReady } from '@/lib/perf/page-ready';
import { markPageCriticalVisual } from '@/lib/perf/page-tracker';
import { supabasePublicImageSrcSet, supabasePublicImageUrl } from '@/lib/supabase-image';
import { cn } from '@/lib/utils';
import {
  useDramaLibraryStore,
  useHydrateDramaLibrary,
  type DramaProgress,
  type DramaLibraryPosition,
} from '@/stores/drama-library-store';

const CATEGORIES = ['全部', '悬疑', '恋爱', '古风', '科幻', '喜剧', '治愈', '脑洞'];

function readLibraryPosition(element: HTMLDivElement, preferredId?: string): DramaLibraryPosition {
  const bounds = element.getBoundingClientRect();
  const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-library-drama-id]'));
  const anchor = preferredId
    ? rows.find((row) => row.dataset.libraryDramaId === preferredId)
    : rows.find((row) => row.getBoundingClientRect().bottom > bounds.top + 1);
  return {
    scroll: element.scrollTop,
    anchorId: anchor?.dataset.libraryDramaId ?? null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
  };
}

function saveLibraryPosition(filter: 'saved' | 'recent', position: DramaLibraryPosition) {
  const state = useDramaLibraryStore.getState();
  state.setBrowse({ libraryPositions: { ...state.browse.libraryPositions, [filter]: position } });
}

export default function DramasPage() {
  const router = useRouter();
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
  const saved = useDramaLibraryStore((state) => state.saved);
  const persistent = useDramaLibraryStore((state) => state.persistent);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const libraryScrollRef = useRef<HTMLDivElement>(null);
  const openedLibraryPosition = useRef<DramaLibraryPosition | null>(null);
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
  const criticalPosterIds = visibleDramas.slice(0, 2).map((drama) => drama.id);
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
  const library =
    browse.libraryFilter === 'recent'
      ? recent
      : saved.flatMap((id) => dramas.find((drama) => drama.id === id) ?? []);
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
    if (browse.tab !== 'library' || !hydrated || isLoading) return;
    const element = libraryScrollRef.current;
    if (!element) return;
    const filter = browse.libraryFilter;
    let position = useDramaLibraryStore.getState().browse.libraryPositions[filter];
    openedLibraryPosition.current = null;
    element.scrollTop = position.scroll;
    const anchor = Array.from(
      element.querySelectorAll<HTMLElement>('[data-library-drama-id]')
    ).find((row) => row.dataset.libraryDramaId === position.anchorId);
    if (anchor) {
      // 最近看过会重排，优先找回刚点过的那部，而不是死守失效的像素位置。
      element.scrollTop +=
        anchor.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        position.anchorOffset;
    }
    const remember = () => {
      position = readLibraryPosition(element);
    };
    remember();
    element.addEventListener('scroll', remember, { passive: true });
    return () => {
      element.removeEventListener('scroll', remember);
      saveLibraryPosition(filter, openedLibraryPosition.current ?? position);
    };
  }, [browse.tab, browse.libraryFilter, hydrated, isLoading]);

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
    setBrowse({ ...patch, scroll: 0 });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const updateKeyword = (keyword: string) => {
    const enteringSearch = !searching && Boolean(keyword.trim());
    const leavingSearch = searching && !keyword.trim();
    const scroll = leavingSearch ? (browse.searchReturnScroll ?? 0) : 0;
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
                  {visibleDramas.map((drama, index) => (
                    <DramaCard
                      key={drama.id}
                      drama={drama}
                      queue={visibleDramas}
                      progress={history[drama.id]}
                      onOpen={rememberScroll}
                      priority={index < 2}
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
              {visibleDramas.length ? (
                <p className="pb-2 pt-8 text-center text-[11px] text-[#eee7e2]/30">
                  找个故事，慢慢入戏
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="absolute inset-x-0 bottom-[var(--app-nav-space)] top-[calc(60px+env(safe-area-inset-top))] flex flex-col px-4">
            <div className="flex shrink-0 items-center gap-2 pb-4 pt-3">
              {(['saved', 'recent'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={browse.libraryFilter === value}
                  onClick={() => setBrowse({ libraryFilter: value })}
                  className={cn(
                    'min-h-11 rounded-full px-5 text-sm',
                    browse.libraryFilter === value
                      ? 'bg-[#dfd2cf] text-[#211d20] font-semibold'
                      : 'bg-white/5 text-[#eee7e2]/55'
                  )}
                >
                  {value === 'saved' ? '已收藏' : '最近看过'}
                </button>
              ))}
              <span className="ml-auto text-xs text-[#eee7e2]/35">{library.length} 部</span>
            </div>
            <div
              key={browse.libraryFilter}
              ref={libraryScrollRef}
              aria-label={browse.libraryFilter === 'saved' ? '已收藏短剧列表' : '最近看过短剧列表'}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-5"
            >
              {library.length ? (
                <div className="space-y-5">
                  {library.map((drama) => (
                    <LibraryRow
                      key={drama.id}
                      drama={drama}
                      progress={history[drama.id]}
                      queue={library}
                      onOpen={() => {
                        if (!libraryScrollRef.current) return;
                        const position = readLibraryPosition(libraryScrollRef.current, drama.id);
                        openedLibraryPosition.current = position;
                        saveLibraryPosition(browse.libraryFilter, position);
                      }}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title={
                    browse.libraryFilter === 'saved' ? '喜欢的故事，留在这里' : '从一个好故事开始'
                  }
                  detail={
                    browse.libraryFilter === 'saved'
                      ? '看到喜欢的剧，点一下「收藏」，下次接着看。'
                      : '看过的短剧会自动留在这里，随时继续。'
                  }
                  action="去发现好剧"
                  onAction={() => router.push('/')}
                />
              )}
              <p className="px-4 pb-3 pt-7 text-center text-[11px] leading-relaxed text-[#eee7e2]/35">
                {persistent
                  ? '收藏与观看进度保存在当前设备'
                  : '当前无法保存到设备，记录仅在本次打开期间保留'}
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function DramaLink({
  drama,
  queue,
  onOpen,
  children,
  className,
  label,
}: {
  drama: DramaSummary;
  queue: DramaSummary[];
  onOpen?: () => void;
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  const prefetch = usePrefetchDramaPlayback();
  return (
    <Link
      href={`/dramas/${drama.id}`}
      prefetch={false}
      className={className}
      aria-label={label ?? `观看 ${drama.title}`}
      onClick={(event) => {
        onOpen?.();
        const progress = useDramaLibraryStore.getState().history[drama.id];
        const videoId = progress && !progress.completed ? progress.videoId : undefined;
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0
        ) {
          const image = event.currentTarget.querySelector('img');
          const cover = !drama.cover_url
            ? { outcome: 'absent' as const }
            : image
              ? image.complete
                ? {
                    outcome: image.naturalWidth > 0 ? ('loaded' as const) : ('error' as const),
                    loadMs: coverLoadMs(image),
                  }
                : { outcome: 'pending' as const }
              : { outcome: 'error' as const };
          dramaTiming.beginPlayback(drama.id, 'cover', videoId, cover);
        }
        prefetch(drama.id, queue, videoId);
      }}
    >
      {children}
    </Link>
  );
}

function Poster({
  drama,
  className,
  priority = false,
  onSettled,
}: {
  drama: DramaSummary;
  className?: string;
  priority?: boolean;
  onSettled?: (outcome: 'loaded' | 'error' | 'absent') => void;
}) {
  const [failed, setFailed] = useState(false);
  const settled = useRef(false);
  const settle = useCallback(
    (outcome: 'loaded' | 'error' | 'absent') => {
      if (settled.current) return;
      settled.current = true;
      onSettled?.(outcome);
    },
    [onSettled]
  );
  useEffect(() => {
    if (!drama.cover_url) settle('absent');
  }, [drama.cover_url, settle]);
  const cover = drama.cover_url
    ? supabasePublicImageUrl(drama.cover_url, { width: 360, height: 480, quality: 68 })
    : undefined;
  const coverSrcSet = drama.cover_url
    ? supabasePublicImageSrcSet(drama.cover_url, [240, 360, 480], { width: 3, height: 4 })
    : undefined;
  return (
    <div className={cn('relative overflow-hidden bg-[#2a272a]', className)}>
      <Clapperboard
        aria-hidden
        className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 text-[#eee7e2]/15"
      />
      {drama.cover_url && !failed ? (
        <img
          ref={(node) => {
            if (node?.complete && node.naturalWidth > 0) settle('loaded');
          }}
          src={cover}
          srcSet={coverSrcSet}
          sizes="(max-width: 640px) 50vw, 240px"
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : 'low'}
          className="absolute inset-0 h-full w-full object-cover"
          onLoad={() => settle('loaded')}
          onError={() => {
            setFailed(true);
            settle('error');
          }}
        />
      ) : null}
    </div>
  );
}

function DramaCard({
  drama,
  queue,
  progress,
  onOpen,
  priority,
  onPosterSettled,
}: {
  drama: DramaSummary;
  queue: DramaSummary[];
  progress?: DramaProgress;
  onOpen: () => void;
  priority: boolean;
  onPosterSettled?: (id: string, outcome: 'loaded' | 'error' | 'absent') => void;
}) {
  return (
    <DramaLink
      drama={drama}
      queue={queue}
      onOpen={onOpen}
      className="min-w-0 overflow-hidden rounded-xl bg-[#1f1d20] pb-3 [content-visibility:auto] [contain-intrinsic-size:0_320px] active:opacity-70"
    >
      <div className="relative">
        <Poster
          drama={drama}
          priority={priority}
          onSettled={onPosterSettled ? (outcome) => onPosterSettled(drama.id, outcome) : undefined}
          className="aspect-[3/4] w-full"
        />
        <div className="absolute inset-x-0 bottom-0 rounded-b-lg bg-gradient-to-t from-black/75 to-transparent px-2 pb-2 pt-6 text-[10px] text-[#eee7e2]/90">
          {progress
            ? progress.completed
              ? '已看完'
              : `看到第 ${progress.episode} 集`
            : drama.episode_count
              ? `${drama.episode_count} 集`
              : '即将开播'}
        </div>
      </div>
      <h2 className="mx-2.5 mt-2.5 line-clamp-2 text-[14px] font-medium leading-[21px]">
        {drama.title}
      </h2>
    </DramaLink>
  );
}

function ContinueWatching({
  drama,
  progress,
  queue,
  onOpen,
}: {
  drama: DramaSummary;
  progress: DramaProgress;
  queue: DramaSummary[];
  onOpen: () => void;
}) {
  return (
    <DramaLink
      drama={drama}
      queue={queue}
      onOpen={onOpen}
      label={`继续观看 ${drama.title}`}
      className="mb-3 mt-1 flex items-center gap-2 rounded-xl bg-white/5 px-3 py-3"
    >
      <Clock3 className="h-4 w-4 shrink-0 text-[#c4a0a7]" />
      <span className="min-w-0 flex-1 truncate text-xs text-[#eee7e2]/70">
        {progress.completed ? '再看一遍' : '接着看'} · {drama.title}
      </span>
      <span className="shrink-0 text-[11px] text-[#eee7e2]/40">第 {progress.episode} 集</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[#eee7e2]/40" />
    </DramaLink>
  );
}

function LibraryRow({
  drama,
  progress,
  queue,
  onOpen,
}: {
  drama: DramaSummary;
  progress?: DramaProgress;
  queue: DramaSummary[];
  onOpen: () => void;
}) {
  const saved = useDramaLibraryStore((state) => state.saved.includes(drama.id));
  const toggleSaved = useDramaLibraryStore((state) => state.toggleSaved);
  return (
    <article className="relative" data-library-drama-id={drama.id}>
      <DramaLink
        drama={drama}
        queue={queue}
        onOpen={onOpen}
        label={`${progress?.completed ? '重看' : '继续观看'} ${drama.title}`}
        className="flex min-w-0 gap-3 rounded-xl active:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c99ea7]/60"
      >
        <Poster drama={drama} className="aspect-[3/4] w-[82px] shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col justify-between py-1">
          <div className="min-w-0 pr-10">
            <h2 className="truncate text-[15px] font-semibold">{drama.title}</h2>
            <p className="mt-1.5 text-xs text-[#eee7e2]/40">共 {drama.episode_count} 集</p>
          </div>
          <div className="flex min-h-11 items-center justify-between gap-1">
            <span className="truncate text-[11px] text-[#eee7e2]/45">
              {progress
                ? progress.completed
                  ? '已看完'
                  : `看到第 ${progress.episode} 集`
                : '还没开始看'}
            </span>
            <span className="flex shrink-0 items-center gap-1 pl-3 text-xs font-semibold text-[#c4a0a7]">
              {progress ? (progress.completed ? '再看一遍' : '继续看') : '开始看'}
              <Play className="h-3 w-3 fill-current" />
            </span>
          </div>
        </div>
      </DramaLink>
      <button
        type="button"
        aria-label={`${saved ? '取消收藏' : '收藏'} ${drama.title}`}
        aria-pressed={saved}
        onClick={() => toggleSaved(drama.id)}
        className="absolute -right-2 -top-1 flex h-11 w-11 items-center justify-center rounded-full active:bg-white/5"
      >
        {saved ? (
          <Check className="h-5 w-5 text-[#c4a0a7]" />
        ) : (
          <Bookmark className="h-5 w-5 text-[#eee7e2]/50" />
        )}
      </button>
    </article>
  );
}

function EmptyState({
  title,
  detail,
  action,
  onAction,
}: {
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div
      role="status"
      className="mx-auto flex max-w-xs flex-col items-center px-4 py-12 text-center"
    >
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5">
        <Clapperboard className="h-7 w-7 text-[#eee7e2]/35" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[#eee7e2]/45">{detail}</p>
      <button
        type="button"
        onClick={onAction}
        className="mt-6 min-h-11 rounded-full bg-[#c99ea7] px-6 text-sm font-semibold text-[#eee7e2] active:bg-[#ba8b96]"
      >
        {action}
      </button>
    </div>
  );
}
