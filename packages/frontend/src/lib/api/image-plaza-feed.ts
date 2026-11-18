'use client';
import {
  IMAGE_PLAZA_INVALID_CURSOR,
  type GetImagePlazaFeedData,
  type GetImagePlazaConfigData,
  type ImagePlazaFeedSort,
} from '@miniapp/shared';
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQueryClient,
  type QueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { apiClient, ApiClientError } from './client';
import { imagePlazaKeys } from './image-plaza-keys';
import { reportPlazaMetric } from '../perf/plaza-metrics';
export const IMAGE_PLAZA_FEED_STALE_TIME_MS = 60_000;

/**
 * feed 的查询配置只此一份：页面 hook 与导航栏的空闲预取共用同一个 key 和 queryFn，
 * 否则预取写进缓存的数据页面读不到。
 */
function imagePlazaFeedQueryOptions(
  search: string,
  tags: string | string[],
  sort: ImagePlazaFeedSort,
  media: 'all' | 'image' | 'video' = 'all'
) {
  const selectedTags = Array.isArray(tags) ? [...tags].sort() : tags === 'all' ? [] : [tags];
  return infiniteQueryOptions({
    queryKey: imagePlazaKeys.feed(search, selectedTags, sort, media),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      params.set('sort', sort);
      if (media !== 'all') params.set('media', media);
      if (search.trim()) params.set('search', search.trim());
      if (selectedTags.length) params.set('tags', selectedTags.join(','));
      if (pageParam) params.set('cursor', pageParam);
      const started = performance.now();
      const deadline = AbortSignal.timeout(10_000);
      let background = typeof document !== 'undefined' && document.hidden;
      const visibility = () => {
        if (document.hidden) background = true;
      };
      if (typeof document !== 'undefined')
        document.addEventListener('visibilitychange', visibility);
      const dimensions = {
        route: '/create' as const,
        media,
        sort,
        cache: 'fetch' as const,
        page_kind: pageParam ? ('next_page' as const) : ('first_page' as const),
        measurement: 'response_parsed' as const,
      };
      try {
        const data = await apiClient<GetImagePlazaFeedData>(
          `/api/image-plaza/feed?${params.toString()}`,
          {
            signal: AbortSignal.any([signal, deadline]),
          }
        );
        reportPlazaMetric(
          'feed',
          background ? 'background' : 'succeeded',
          performance.now() - started,
          dimensions
        );
        return data;
      } catch (error) {
        reportPlazaMetric(
          'feed',
          signal.aborted
            ? 'cancelled'
            : deadline.aborted ||
                (error instanceof ApiClientError && error.code === 'client_timeout')
              ? 'timeout'
              : 'error',
          performance.now() - started,
          dimensions
        );
        throw error;
      } finally {
        if (typeof document !== 'undefined')
          document.removeEventListener('visibilitychange', visibility);
      }
    },
    getNextPageParam: (page: GetImagePlazaFeedData) => page.next_cursor ?? undefined,
    staleTime: IMAGE_PLAZA_FEED_STALE_TIME_MS,
    // A different filter/order must never display or continue the previous cursor chain.
    retry: false,
  });
}

/**
 * 默认视图（无搜索、全部标签、推荐）的首页预取。失败静默：页面挂载时会自己再请求一次，
 * 预取只负责让「点进创作」时已经有数据可画。
 */
export function prefetchImagePlazaFeed(client: QueryClient): Promise<void> {
  return client.prefetchInfiniteQuery(imagePlazaFeedQueryOptions('', [], 'recommended', 'all'));
}

export function prefetchImagePlazaConfig(client: QueryClient): Promise<void> {
  return client.prefetchQuery({
    queryKey: imagePlazaKeys.config(),
    queryFn: () => apiClient<GetImagePlazaConfigData>('/api/image-plaza/config'),
    staleTime: 60_000,
  });
}

export function useImagePlazaFeedQuery(
  search: string,
  tags: string | string[],
  sort: ImagePlazaFeedSort = 'recommended',
  media: 'all' | 'image' | 'video' = 'all'
) {
  const client = useQueryClient();
  const query = useInfiniteQuery({
    ...imagePlazaFeedQueryOptions(search, tags, sort, media),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    const key = imagePlazaKeys.feed(search, tags, sort, media);
    const state = client.getQueryState(key);
    const stale =
      state?.isInvalidated ||
      (state?.dataUpdatedAt && Date.now() - state.dataUpdatedAt > IMAGE_PLAZA_FEED_STALE_TIME_MS);
    if (!stale) return;
    // 不用 resetQueries：它会清空数据，每次回到这页都先看到整屏骨架。
    // 这里只保留第一页先展示（图片多半还在浏览器缓存里），再整体刷新；
    // 第二页起的游标可能已经失效，必须丢弃，翻页由 sentinel 在刷新结束后重新驱动。
    // updatedAt 保持原值：刷新若失败，这份旧数据仍然是过期的，下次进页要继续重试。
    client.setQueryData<InfiniteData<GetImagePlazaFeedData, string | undefined>>(
      key,
      (old) =>
        old ? { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) } : old,
      { updatedAt: state?.dataUpdatedAt }
    );
    void client.refetchQueries({ queryKey: key, exact: true });
  }, [client, search, tags, sort, media]);
  const recovery = useRef({ key: '', attempted: false });
  const viewKey = JSON.stringify(imagePlazaKeys.feed(search, tags, sort, media));
  if (recovery.current.key !== viewKey) recovery.current = { key: viewKey, attempted: false };
  useEffect(() => {
    if (
      !(query.error instanceof ApiClientError) ||
      query.error.code !== IMAGE_PLAZA_INVALID_CURSOR ||
      recovery.current.attempted
    )
      return;
    recovery.current.attempted = true;
    // Discard the whole chain: an old head cannot be stitched to a new ranking revision.
    void client.resetQueries({
      queryKey: imagePlazaKeys.feed(search, tags, sort, media),
      exact: true,
    });
  }, [query.error, client, search, tags, sort, media]);
  const subscribe = useCallback(
    (notify: () => void) => client.getQueryCache().subscribe(notify),
    [client]
  );
  const paginationInvalidated = useSyncExternalStore(
    subscribe,
    () =>
      client.getQueryState(imagePlazaKeys.feed(search, tags, sort, media))?.isInvalidated === true,
    () => false
  );
  return { ...query, paginationInvalidated };
}
