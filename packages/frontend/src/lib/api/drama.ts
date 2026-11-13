'use client';

import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { createRequestId } from '@/lib/perf/request-timing';
import type {
  DramaDetail,
  DramaPlayback,
  DramaSummary,
  GetDramaByIdData,
  DramaPlayRequest,
  GetDramaPlaybackData,
  GetDramasData,
  GetDramaSocialData,
  GetDramaCommentsData,
  CreateDramaComment,
  CreateDramaCommentData,
  DramaSocial,
} from '@miniapp/shared';

import { apiClient } from './client';
import { dramaTiming } from '@/lib/perf/drama-observer';
import { capAppleHlsQuality } from '@/lib/drama-media-source';
import { warmDramaStreamOrigin } from '@/lib/drama-stream-origin';

const DRAMA_CATALOG_CACHE_KEY = 'miniapp:drama-catalog:stream-v2';
const DRAMA_CATALOG_STALE_MS = 15 * 60_000;
const DRAMA_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
const DRAMA_CATALOG_MAX_ITEMS = 300;

interface PersistedDramaCatalog {
  savedAt: number;
  data: DramaSummary[];
}

let persistedCatalog: PersistedDramaCatalog | null | undefined;
let catalogPersistScheduled = false;
let pendingCatalog: DramaSummary[] | undefined;

function isDramaSummary(value: unknown): value is DramaSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DramaSummary>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    (typeof item.cover_url === 'string' || item.cover_url === null) &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === 'string') &&
    typeof item.description === 'string' &&
    typeof item.episode_count === 'number' &&
    Number.isFinite(item.episode_count) &&
    (typeof item.duration_seconds === 'number' || item.duration_seconds === null)
  );
}

function readPersistedDramaCatalog(): PersistedDramaCatalog | undefined {
  if (persistedCatalog !== undefined) return persistedCatalog ?? undefined;
  persistedCatalog = null;
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(DRAMA_CATALOG_CACHE_KEY);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as Partial<PersistedDramaCatalog>;
    if (
      typeof cached.savedAt !== 'number' ||
      Date.now() - cached.savedAt > DRAMA_CATALOG_MAX_AGE_MS ||
      !Array.isArray(cached.data) ||
      cached.data.length > DRAMA_CATALOG_MAX_ITEMS ||
      !cached.data.every(isDramaSummary)
    ) {
      window.localStorage.removeItem(DRAMA_CATALOG_CACHE_KEY);
      return undefined;
    }
    persistedCatalog = { savedAt: cached.savedAt, data: cached.data };
    return persistedCatalog;
  } catch {
    return undefined;
  }
}

function flushPersistedDramaCatalog(): void {
  catalogPersistScheduled = false;
  const data = pendingCatalog;
  pendingCatalog = undefined;
  if (!data) return;
  const snapshot = { savedAt: Date.now(), data: data.slice(0, DRAMA_CATALOG_MAX_ITEMS) };
  persistedCatalog = snapshot;
  try {
    window.localStorage.setItem(DRAMA_CATALOG_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage unavailable/quota exceeded: React Query's in-memory cache still works.
  }
}

function persistDramaCatalog(data: DramaSummary[]): void {
  if (typeof window === 'undefined') return;
  pendingCatalog = data;
  if (catalogPersistScheduled) return;
  catalogPersistScheduled = true;
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(flushPersistedDramaCatalog, { timeout: 3000 });
  } else {
    window.setTimeout(flushPersistedDramaCatalog, 500);
  }
}

export const dramaKeys = {
  all: ['dramas'] as const,
  list: () => [...dramaKeys.all, 'list'] as const,
  browseQueue: () => [...dramaKeys.all, 'browse-queue'] as const,
  detail: (id: string) => [...dramaKeys.all, 'detail', id] as const,
  social: (id: string) => [...dramaKeys.all, 'social', id] as const,
  comments: (id: string) => [...dramaKeys.all, 'comments', id] as const,
  playback: (id: string, videoId?: string) =>
    [...dramaKeys.all, 'playback', id, videoId ?? null] as const,
};

export function useDramaSocialQuery(id: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: dramaKeys.social(id),
    queryFn: async ({ signal }) =>
      (
        await apiClient<GetDramaSocialData>(`/api/dramas/${encodeURIComponent(id)}/social`, {
          signal,
          timeoutMs: 5000,
          queuePriority: 'background',
        })
      ).social,
    retry: false,
    staleTime: 30_000,
  });
}

export function useDramaLikeMutation(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...dramaKeys.social(id), 'like'],
    mutationFn: (liked: boolean) =>
      apiClient<GetDramaSocialData>(`/api/dramas/${encodeURIComponent(id)}/like`, {
        method: 'PUT',
        body: JSON.stringify({ liked }),
        timeoutMs: 8000,
      }),
    onMutate: async (liked) => {
      await client.cancelQueries({ queryKey: dramaKeys.social(id) });
      const previous = client.getQueryData<DramaSocial>(dramaKeys.social(id));
      if (previous)
        client.setQueryData(dramaKeys.social(id), {
          ...previous,
          liked,
          like_count: Math.max(
            0,
            previous.like_count + (liked === previous.liked ? 0 : liked ? 1 : -1)
          ),
        });
      return { previous };
    },
    onSuccess: (data) => client.setQueryData(dramaKeys.social(id), data.social),
    onError: (_err, _liked, context) => {
      if (context?.previous) client.setQueryData(dramaKeys.social(id), context.previous);
      // A timeout can arrive after the write committed. Recover truth instead of guessing.
      void client.invalidateQueries({ queryKey: dramaKeys.social(id) });
    },
    retry: false,
  });
}

export function useDramaCommentsQuery(id: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: dramaKeys.comments(id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiClient<GetDramaCommentsData>(
        `/api/dramas/${encodeURIComponent(id)}/comments${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal, timeoutMs: 5000, queuePriority: 'background' }
      ),
    getNextPageParam: (last) => last.next_cursor,
    enabled,
    retry: false,
  });
}

export function useDramaCommentMutations(id: string) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: dramaKeys.comments(id) });
    void client.invalidateQueries({ queryKey: dramaKeys.social(id) });
  };
  const create = useMutation({
    mutationFn: (body: CreateDramaComment) =>
      apiClient<CreateDramaCommentData>(`/api/dramas/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: 8000,
      }),
    onSuccess: refresh,
    retry: false,
  });
  const remove = useMutation({
    mutationFn: (commentId: string) =>
      apiClient<{ deleted: boolean }>(
        `/api/dramas/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'DELETE', timeoutMs: 8000 }
      ),
    onSuccess: refresh,
    retry: false,
  });
  return { create, remove };
}

async function fetchDramas(
  kind: 'list' | 'queue' = 'list',
  signal?: AbortSignal,
  route: '/watch' | '/dramas' = '/dramas'
): Promise<DramaSummary[]> {
  return dramaTiming.query(
    kind,
    undefined,
    undefined,
    async (onAttempt) => {
      const data = await apiClient<GetDramasData>('/api/dramas', {
        onAttempt,
        signal,
        timeoutMs: 5000,
        queuePriority: kind === 'list' ? 'critical' : 'background',
      });
      persistDramaCatalog(data.dramas);
      return data.dramas;
    },
    route
  );
}

async function fetchDramaDetail(
  id: string,
  signal?: AbortSignal,
  priority: 'critical' | 'background' = 'critical'
): Promise<DramaDetail> {
  return dramaTiming.query('detail', id, undefined, async (onAttempt) => {
    const data = await apiClient<GetDramaByIdData>(`/api/dramas/${encodeURIComponent(id)}`, {
      onAttempt,
      signal,
      timeoutMs: 5000,
      queuePriority: priority,
    });
    return data.drama;
  });
}

async function fetchDramaPlayback(
  id: string,
  videoId?: string,
  signal?: AbortSignal
): Promise<DramaPlayback> {
  // 固定地址的 POST：CORS 预检按 URL 缓存，原来每集一个 URL 导致每次都要预检。
  const body: DramaPlayRequest = { drama_id: id };
  if (videoId) body.video_id = videoId;
  if (
    typeof document !== 'undefined' &&
    (document.createElement('video').canPlayType('application/vnd.apple.mpegurl') ||
      typeof MediaSource !== 'undefined')
  )
    body.format = 'hls';
  return dramaTiming.query('playback', id, videoId, async (onAttempt) => {
    const data = await apiClient<GetDramaPlaybackData>('/api/dramas/play', {
      method: 'POST',
      body: JSON.stringify(body),
      // /play 只读，沿用 GET 时的传输层重试，吸收客户端到 Railway 的瞬时抖动。
      idempotent: true,
      onAttempt,
      signal,
      timeoutMs: 5000,
      queuePriority: 'critical',
    });
    return capAppleHlsQuality(data.playback);
  });
}

// 播放意图在点击当下就发出取址，播放器挂载后的 useDramaPlaybackQuery 再接上这次请求，
// 省掉路由跳转 + 播放器挂载（约 0.5s）的等待。请求不进 React Query 缓存：
// 每次意图仍然重新取址（不复用意图发生前的结果），也就不需要放开 gcTime: 0。
const PLAY_INTENT_TTL_MS = 10_000;
const playIntents = new Map<string, { promise: Promise<DramaPlayback>; startedAt: number }>();
const playIntentKey = (id: string, videoId?: string) => `${id}:${videoId ?? ''}`;

/** 必须在 dramaTiming.beginPlayback 之后调用，请求才会挂到本次播放观察上。 */
export function startDramaPlayIntent(id: string, videoId?: string): void {
  const now = Date.now();
  for (const [key, intent] of playIntents) {
    if (now - intent.startedAt > PLAY_INTENT_TTL_MS) playIntents.delete(key);
  }
  const promise = fetchDramaPlayback(id, videoId);
  warmDramaStreamOrigin();
  // 没被接上时无人处理拒绝；接上的一方仍会拿到原始拒绝。
  promise.catch(() => undefined);
  playIntents.set(playIntentKey(id, videoId), { promise, startedAt: now });
}

/**
 * 取播放地址：优先接上同 (剧, 集) 的意图请求（10 秒内有效、只用一次），接不上就新建请求。
 * 播放失败后重新签发地址，跳过可能已失效的意图请求。
 */
export function loadDramaPlayback(
  id: string,
  videoId?: string,
  signal?: AbortSignal,
  freshRequest = false
): Promise<DramaPlayback> {
  const key = playIntentKey(id, videoId);
  const intent = freshRequest ? undefined : playIntents.get(key);
  if (!freshRequest) playIntents.delete(key);
  return intent && Date.now() - intent.startedAt <= PLAY_INTENT_TTL_MS
    ? intent.promise
    : fetchDramaPlayback(id, videoId, signal);
}

// 保留结果对象身份，防止 structural sharing 把本次请求映射到旧对象的计时元数据。
export function useDramaListQuery(route: '/watch' | '/dramas' = '/dramas') {
  return useQuery({
    queryKey: dramaKeys.list(),
    queryFn: ({ signal }) => fetchDramas('list', signal, route),
    initialData: () => readPersistedDramaCatalog()?.data,
    initialDataUpdatedAt: () => readPersistedDramaCatalog()?.savedAt,
    staleTime: DRAMA_CATALOG_STALE_MS,
    gcTime: DRAMA_CATALOG_MAX_AGE_MS,
    structuralSharing: false,
    retry: false,
  });
}

/** 换剧跨路由保留本轮列表顺序；深链没有列表缓存时才自行加载。 */
export function useDramaBrowseQueueQuery() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: dramaKeys.browseQueue(),
    queryFn: ({ signal }) => fetchDramas('queue', signal),
    initialData: () => queryClient.getQueryData<DramaSummary[]>(dramaKeys.list()),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 放映页的换剧队列：剧场点封面/随便看看时冻结的顺序；深链没有快照时退回目录。
 * 只订阅缓存不发请求，避免冷启动深链在目录之外再拉一次队列。
 */
export function useDramaFeedQueue(catalog: DramaSummary[] | undefined): DramaSummary[] | undefined {
  const { data } = useQuery<DramaSummary[]>({
    queryKey: dramaKeys.browseQueue(),
    queryFn: skipToken,
    staleTime: Infinity,
  });
  return data ?? catalog;
}

export function useDramaDetailQuery(id: string) {
  return useQuery({
    queryKey: dramaKeys.detail(id),
    queryFn: ({ signal }) => fetchDramaDetail(id, signal),
    structuralSharing: false,
    enabled: Boolean(id),
    retry: false,
  });
}

/** Each playback intent confirms the current provider; a prefetched old CDN URL cannot bypass shutdown. */
export function useDramaPlaybackQuery(id: string, videoId?: string, freshRequest = false) {
  const intent = useMemo(() => `${id}:${videoId ?? ''}:${createRequestId()}`, [id, videoId]);
  return useQuery({
    queryKey: [...dramaKeys.playback(id, videoId), 'intent', intent, freshRequest],
    queryFn: ({ signal }) => loadDramaPlayback(id, videoId, signal, freshRequest),
    structuralSharing: false,
    enabled: Boolean(id),
    gcTime: 0,
    retry: false,
  });
}

/** 临近片尾只预取详情；视频地址在实际播放时确认当前路径。 */
export function usePreloadDramaPlayback() {
  const client = useQueryClient();
  return useCallback(
    (id: string, _videoId?: string) => {
      void client.prefetchQuery({
        queryKey: dramaKeys.detail(id),
        queryFn: ({ signal }) => fetchDramaDetail(id, signal, 'background'),
        retry: false,
      });
    },
    [client]
  );
}

/** 点击卡片固定筛选队列，并在点击当下发出本次播放意图的取址（需在 beginPlayback 之后调用）。 */
export function usePrefetchDramaPlayback() {
  const queryClient = useQueryClient();
  return (id: string, browseQueue?: DramaSummary[], videoId?: string) => {
    // 点击时固定当前筛选/排序后的队列，保证进入播放后的上下滑仍沿用所见顺序。
    const list = browseQueue ?? queryClient.getQueryData<DramaSummary[]>(dramaKeys.list());
    if (list) queryClient.setQueryData(dramaKeys.browseQueue(), list);
    startDramaPlayIntent(id, videoId);
  };
}
