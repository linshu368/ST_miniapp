'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { GetImagePlazaFeedData, ImagePlazaFeedSort } from '@miniapp/shared';
import {
  IMAGE_PLAZA_FEED_STALE_TIME_MS,
  imagePlazaKeys,
  prefetchImagePlazaConfig,
  useCreateImagePlazaConversationMutation,
  useImagePlazaConfigQuery,
  useImagePlazaFeedQuery,
  useImagePlazaTagCountsQuery,
} from '@/lib/api/image-plaza';
import {
  clearImagePlazaReturn,
  readImagePlazaReturn,
  restoreImagePlazaReturn,
  saveImagePlazaReturn,
} from '@/lib/image-plaza-return';
import { useMobilePerformancePolicy } from '@/lib/mobile-performance';
import { markCriticalSettled } from '@/lib/entry-phase';
import { discardPendingAction, startPendingAction } from '@/lib/perf/action-tracker';
import { usePageReady } from '@/lib/perf/page-ready';
import { markPageCriticalVisual } from '@/lib/perf/page-tracker';
import { usePlazaPosterTiming } from './use-plaza-poster-timing';

function useGalleryQueries() {
  const [returnSnapshot] = useState(readImagePlazaReturn);
  const [search, setSearch] = useState(returnSnapshot?.search ?? '');
  const [selectedTags, setSelectedTags] = useState<string[]>(
    returnSnapshot?.tags ??
      (returnSnapshot?.tag && returnSnapshot.tag !== 'all' ? [returnSnapshot.tag] : [])
  );
  const [media, setMedia] = useState<'all' | 'image' | 'video'>(returnSnapshot?.media ?? 'all');
  const [sort, setSort] = useState<ImagePlazaFeedSort>(returnSnapshot?.sort ?? 'recommended');
  const [debouncedSearch, setDebouncedSearch] = useState(returnSnapshot?.search ?? '');
  const [tags, setTags] = useState<GetImagePlazaFeedData['tags']>([]);
  const [criticalVisualSettled, setCriticalVisualSettled] = useState(false);
  const stableTags = useMemo(() => [...selectedTags].sort(), [selectedTags]);
  const feed = useImagePlazaFeedQuery(debouncedSearch, stableTags, sort, media);
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (feed.data?.pages.flatMap((page) => page.items) ?? []).filter((work) => {
      if (seen.has(work.id)) return false;
      seen.add(work.id);
      return true;
    });
  }, [feed.data]);
  const availableTags = useMemo(() => tags.filter((tag) => tag.id !== 'all'), [tags]);
  const tagCounts = useImagePlazaTagCountsQuery(
    debouncedSearch,
    media,
    availableTags.length > 0 && criticalVisualSettled
  );
  useImagePlazaConfigQuery({ enabled: criticalVisualSettled || feed.isError });
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const feedTags = feed.data?.pages[0]?.tags;
  useEffect(() => {
    if (!feedTags) return;
    setTags(feedTags);
    setSelectedTags((current) => current.filter((id) => feedTags.some((tag) => tag.id === id)));
  }, [feedTags]);
  useEffect(() => {
    if (criticalVisualSettled || feed.isError) markCriticalSettled();
    if (criticalVisualSettled || feed.data === undefined || feed.isError) return;
    // Release background work on decode failure, without fabricating critical-visual success.
    const timer = setTimeout(() => setCriticalVisualSettled(true), 1500);
    return () => clearTimeout(timer);
  }, [criticalVisualSettled, feed.data, feed.isError]);
  const feedViewKey = JSON.stringify([debouncedSearch, stableTags, sort, media]);
  return {
    returnSnapshot,
    search,
    setSearch,
    selectedTags,
    setSelectedTags,
    media,
    setMedia,
    sort,
    setSort,
    debouncedSearch,
    stableTags,
    tags,
    availableTags,
    tagCounts,
    feed,
    items,
    feedViewKey,
    setCriticalVisualSettled,
  };
}
type GalleryQueries = ReturnType<typeof useGalleryQueries>;

function useCriticalPreview(q: GalleryQueries) {
  const { items, feed, feedViewKey, media, sort, setCriticalVisualSettled } = q;
  const finishPoster = usePlazaPosterTiming(feedViewKey, { route: '/create', media, sort });
  const ids = useMemo(() => items.slice(0, 2).map((item) => item.id), [items]);
  const key = `${feedViewKey}:${ids.join(':')}`;
  const state = useRef({ key, outcomes: new Map<string, 'loaded' | 'error' | 'absent'>() });
  if (state.current.key !== key) state.current = { key, outcomes: new Map() };
  const handle = useCallback(
    (id: string, outcome: 'loaded' | 'error' | 'absent') => {
      if (!ids.includes(id) || state.current.key !== key || state.current.outcomes.has(id)) return;
      state.current.outcomes.set(id, outcome);
      if (state.current.outcomes.size !== ids.length) return;
      const outcomes = [...state.current.outcomes.values()];
      finishPoster(
        outcomes.includes('error') ? 'error' : outcomes.includes('loaded') ? 'loaded' : 'absent'
      );
      setCriticalVisualSettled(true);
      markPageCriticalVisual(
        '/create',
        outcomes.includes('error') ? 'error' : outcomes.includes('loaded') ? 'loaded' : 'absent',
        undefined,
        feed.data !== undefined && feed.isFetching ? 'cache' : 'fetch'
      );
    },
    [ids, key, setCriticalVisualSettled, feed.data, feed.isFetching, finishPoster]
  );
  useEffect(() => {
    if (feed.data === undefined || ids.length > 0) return;
    finishPoster(feed.isError ? 'error' : 'absent');
    setCriticalVisualSettled(true);
    markPageCriticalVisual(
      '/create',
      feed.isError ? 'error' : 'absent',
      undefined,
      feed.isFetching ? 'cache' : 'fetch'
    );
  }, [
    feed.data,
    feed.isError,
    feed.isFetching,
    setCriticalVisualSettled,
    ids.length,
    finishPoster,
  ]);
  useEffect(() => {
    if (!feed.isError || items.length > 0) return;
    finishPoster('error');
    setCriticalVisualSettled(true);
    markPageCriticalVisual('/create', 'error', undefined, 'fetch');
  }, [feed.isError, items.length, setCriticalVisualSettled, finishPoster]);
  usePageReady(
    '/create',
    feed.data !== undefined && (!feed.isError || items.length > 0),
    false,
    feed.isError
  );
  return handle;
}

function useGalleryReturn(q: GalleryQueries) {
  const restoring = useRef(q.returnSnapshot !== null);
  useEffect(() => {
    if (!q.returnSnapshot) return;
    clearImagePlazaReturn();
    const cancel = () => {
      restoring.current = false;
    };
    const timer = setTimeout(cancel, 2000);
    window.addEventListener('pointerdown', cancel, { passive: true });
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('keydown', cancel);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', cancel);
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('keydown', cancel);
    };
  }, [q.returnSnapshot]);
  useLayoutEffect(() => {
    if (
      !q.returnSnapshot ||
      !restoring.current ||
      !q.feed.data ||
      q.feed.isFetching ||
      q.feed.paginationInvalidated
    )
      return;
    if (Date.now() - q.feed.dataUpdatedAt > IMAGE_PLAZA_FEED_STALE_TIME_MS) return;
    restoreImagePlazaReturn(q.returnSnapshot);
    restoring.current = false;
  }, [
    q.returnSnapshot,
    q.feed.data,
    q.feed.dataUpdatedAt,
    q.feed.isFetching,
    q.feed.paginationInvalidated,
  ]);
  return restoring;
}

function useGalleryActions(q: GalleryQueries) {
  const router = useRouter();
  const client = useQueryClient();
  const createConversation = useCreateImagePlazaConversationMutation();
  const [pendingSourceWorkId, setPendingSourceWorkId] = useState<string | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const saveReturn = (workId?: string) =>
    saveImagePlazaReturn(
      { search: q.search, tags: q.stableTags, media: q.media, sort: q.sort },
      workId
    );
  const startStudio = (sourceWorkId?: string) => {
    saveReturn(sourceWorkId);
    void prefetchImagePlazaConfig(client);
    setPendingSourceWorkId(sourceWorkId ?? 'new');
    startPendingAction('create_conversation');
    createConversation.mutate(sourceWorkId ? { source_work_id: sourceWorkId } : {}, {
      onSuccess: ({ conversation }) => router.push(`/create/studio/${conversation.id}`),
      onError: () => {
        discardPendingAction('create_conversation');
        clearImagePlazaReturn();
        setPendingSourceWorkId(null);
      },
    });
  };
  const refreshFeed = async () => {
    if (isPullRefreshing || q.feed.isFetchingNextPage) return;
    setIsPullRefreshing(true);
    try {
      await client.resetQueries({
        queryKey: imagePlazaKeys.feed(q.debouncedSearch, q.stableTags, q.sort, q.media),
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
  return {
    router,
    createConversation,
    pendingSourceWorkId,
    saveReturn,
    startStudio,
    refreshFeed,
    pullDistance,
    isPullRefreshing,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}

export function usePlazaGallery() {
  const q = useGalleryQueries();
  const restoring = useGalleryReturn(q);
  const handleCriticalPreviewSettled = useCriticalPreview(q);
  const actions = useGalleryActions(q);
  const performancePolicy = useMobilePerformancePolicy();
  return { ...q, ...actions, restoring, performancePolicy, handleCriticalPreviewSettled };
}
export type GalleryController = ReturnType<typeof usePlazaGallery>;
