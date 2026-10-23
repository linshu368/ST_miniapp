'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useIsMutating,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type {
  CreateImagePlazaConversationData,
  CreateImagePlazaConversationRequest,
  GetImagePlazaConfigData,
  GetImagePlazaConversationData,
  GetImagePlazaConversationsData,
  GetImagePlazaFeedData,
  GetImagePlazaWorkData,
  ImagePlazaQuoteData,
  ImagePlazaQuoteRequest,
  ImagePlazaWork,
  ImagePlazaFeedSort,
  SetImagePlazaLikeData,
  ShareImagePlazaWorkData,
  ShareImagePlazaWorkRequest,
  SubmitImagePlazaAttemptData,
  SubmitImagePlazaAttemptRequest,
  UploadImagePlazaReferenceData,
  UploadImagePlazaReferenceRequest,
} from '@miniapp/shared';
import { apiClient, ApiClientError } from './client';
import { paymentKeys } from './payment';

export const imagePlazaKeys = {
  all: ['image-plaza'] as const,
  config: () => [...imagePlazaKeys.all, 'config'] as const,
  feed: (search: string, tag: string, sort: ImagePlazaFeedSort = 'recommended') =>
    [...imagePlazaKeys.all, 'feed', 1, search.trim(), tag, sort] as const,
  work: (id: string) => [...imagePlazaKeys.all, 'work', id] as const,
  conversations: () => [...imagePlazaKeys.all, 'conversations'] as const,
  conversation: (id: string) => [...imagePlazaKeys.all, 'conversation', id] as const,
  attempt: (id: string) => [...imagePlazaKeys.all, 'attempt', id] as const,
};

export const IMAGE_PLAZA_FEED_STALE_TIME_MS = 60_000;

export function useImagePlazaConfigQuery() {
  return useQuery({
    queryKey: imagePlazaKeys.config(),
    queryFn: () => apiClient<GetImagePlazaConfigData>('/api/image-plaza/config'),
    staleTime: 60_000,
  });
}

/**
 * feed 的查询配置只此一份：页面 hook 与导航栏的空闲预取共用同一个 key 和 queryFn，
 * 否则预取写进缓存的数据页面读不到。
 */
function imagePlazaFeedQueryOptions(search: string, tag: string, sort: ImagePlazaFeedSort) {
  return infiniteQueryOptions({
    queryKey: imagePlazaKeys.feed(search, tag, sort),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      params.set('sort', sort);
      if (search.trim()) params.set('search', search.trim());
      if (tag !== 'all') params.set('tag', tag);
      if (pageParam) params.set('cursor', pageParam);
      return apiClient<GetImagePlazaFeedData>(`/api/image-plaza/feed?${params.toString()}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
    },
    getNextPageParam: (page: GetImagePlazaFeedData) => page.next_cursor ?? undefined,
    staleTime: IMAGE_PLAZA_FEED_STALE_TIME_MS,
    // A different filter/order must never display or continue the previous cursor chain.
    retry: (count: number, error: Error) =>
      count < 1 && !(error instanceof ApiClientError && error.status < 500),
  });
}

/**
 * 默认视图（无搜索、全部标签、推荐）的首页预取。失败静默：页面挂载时会自己再请求一次，
 * 预取只负责让「点进创作」时已经有数据可画。
 */
export function prefetchImagePlazaFeed(client: QueryClient): Promise<void> {
  return client.prefetchInfiniteQuery(imagePlazaFeedQueryOptions('', 'all', 'recommended'));
}

export function useImagePlazaFeedQuery(
  search: string,
  tag: string,
  sort: ImagePlazaFeedSort = 'recommended'
) {
  const client = useQueryClient();
  const query = useInfiniteQuery({
    ...imagePlazaFeedQueryOptions(search, tag, sort),
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    const key = imagePlazaKeys.feed(search, tag, sort);
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
  }, [client, search, tag, sort]);
  const subscribe = useCallback(
    (notify: () => void) => client.getQueryCache().subscribe(notify),
    [client]
  );
  const paginationInvalidated = useSyncExternalStore(
    subscribe,
    () => client.getQueryState(imagePlazaKeys.feed(search, tag, sort))?.isInvalidated === true,
    () => false
  );
  return { ...query, paginationInvalidated };
}

export function useImagePlazaWorkQuery(id: string) {
  const client = useQueryClient();
  return useQuery<GetImagePlazaWorkData>({
    queryKey: imagePlazaKeys.work(id),
    queryFn: ({ signal }) =>
      apiClient<GetImagePlazaWorkData>(`/api/image-plaza/works/${id}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
    enabled: Boolean(id),
    staleTime: 60_000,
    placeholderData: () => {
      const feeds = client.getQueriesData<InfiniteData<GetImagePlazaFeedData>>({
        queryKey: [...imagePlazaKeys.all, 'feed'],
      });
      for (const [, feed] of feeds) {
        const work = feed?.pages.flatMap((page) => page.items).find((item) => item.id === id);
        if (work) return { work };
      }
      return undefined;
    },
  });
}

export function useImagePlazaConversationsQuery() {
  return useQuery({
    queryKey: imagePlazaKeys.conversations(),
    queryFn: () => apiClient<GetImagePlazaConversationsData>('/api/image-plaza/conversations'),
  });
}

export function useImagePlazaConversationQuery(id: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: imagePlazaKeys.conversation(id),
    queryFn: async () => {
      const next = await apiClient<GetImagePlazaConversationData>(
        `/api/image-plaza/conversations/${id}`
      );
      const current = client.getQueryData<GetImagePlazaConversationData>(
        imagePlazaKeys.conversation(id)
      );
      const previousReady = new Set(
        current?.conversation.messages.flatMap(({ attempt }) =>
          attempt?.status === 'ready' ? [attempt.id] : []
        ) ?? []
      );
      // Compare shared cache so completion while away is reconciled once on return.
      if (
        next.conversation.messages.some(
          ({ attempt }) => attempt?.status === 'ready' && !previousReady.has(attempt.id)
        )
      ) {
        void client.invalidateQueries({ queryKey: paymentKeys.wallet() });
      }
      return next;
    },
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const conversation = query.state.data?.conversation;
      return conversation?.messages.some((message) =>
        message.attempt ? ['pending', 'generating'].includes(message.attempt.status) : false
      )
        ? 2000
        : false;
    },
  });
}

export function useCreateImagePlazaConversationMutation() {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (body: CreateImagePlazaConversationRequest = {}) =>
      apiClient<CreateImagePlazaConversationData>('/api/image-plaza/conversations', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }),
    onSuccess: (data) => {
      // 创建接口已返回完整空会话，先写缓存可让“用同款”导航立即渲染，再后台维护列表。
      client.setQueryData(imagePlazaKeys.conversation(data.conversation.id), data);
      void client.invalidateQueries({ queryKey: imagePlazaKeys.conversations() });
    },
  });
}

export function useImagePlazaQuoteMutation() {
  return useMutation({
    mutationFn: (body: ImagePlazaQuoteRequest) =>
      apiClient<ImagePlazaQuoteData>('/api/image-plaza/quotes', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useUploadImagePlazaReferenceMutation() {
  return useMutation({
    retry: false,
    mutationFn: (body: UploadImagePlazaReferenceRequest) =>
      apiClient<UploadImagePlazaReferenceData>('/api/image-plaza/references', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      }),
  });
}

export function useSubmitImagePlazaAttemptMutation(conversationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SubmitImagePlazaAttemptRequest) =>
      apiClient<SubmitImagePlazaAttemptData>(
        `/api/image-plaza/conversations/${conversationId}/attempts`,
        { method: 'POST', body: JSON.stringify(body) }
      ),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: imagePlazaKeys.conversation(conversationId) }),
  });
}

type LikeFields = Pick<ImagePlazaWork, 'liked' | 'like_count'>;
type LikeSnapshot = { key: QueryKey; fields: LikeFields };

/** Patch only the target's fields so another work's concurrent mutation is never rolled back. */
export function patchImagePlazaLike(
  client: QueryClient,
  workId: string,
  patch: (work: LikeFields) => LikeFields
): LikeSnapshot[] {
  const snapshots: LikeSnapshot[] = [];
  const detailKey = imagePlazaKeys.work(workId);
  const detail = client.getQueryData<GetImagePlazaWorkData>(detailKey);
  if (detail) {
    snapshots.push({
      key: detailKey,
      fields: { liked: detail.work.liked, like_count: detail.work.like_count },
    });
    client.setQueryData<GetImagePlazaWorkData>(detailKey, {
      work: { ...detail.work, ...patch(detail.work) },
    });
  }
  for (const [key, feed] of client.getQueriesData<InfiniteData<GetImagePlazaFeedData>>({
    queryKey: [...imagePlazaKeys.all, 'feed'],
  })) {
    const work = feed?.pages.flatMap((page) => page.items).find((item) => item.id === workId);
    if (!feed || !work) continue;
    snapshots.push({ key, fields: { liked: work.liked, like_count: work.like_count } });
    client.setQueryData<InfiniteData<GetImagePlazaFeedData>>(key, {
      ...feed,
      pages: feed.pages.map((page) => ({
        ...page,
        items: page.items.map((item) => (item.id === workId ? { ...item, ...patch(item) } : item)),
      })),
    });
  }
  return snapshots;
}

export function restoreImagePlazaLike(
  client: QueryClient,
  workId: string,
  snapshots: LikeSnapshot[]
) {
  for (const { key, fields } of snapshots) {
    if (key[1] === 'work') {
      client.setQueryData<GetImagePlazaWorkData>(key, (data) =>
        data ? { work: { ...data.work, ...fields } } : data
      );
    } else {
      client.setQueryData<InfiniteData<GetImagePlazaFeedData>>(key, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === workId ? { ...item, ...fields } : item
                ),
              })),
            }
          : data
      );
    }
  }
}

export function useSetImagePlazaLikeMutation(workId: string) {
  const client = useQueryClient();
  const mutationKey = [...imagePlazaKeys.all, 'like', workId];
  const pending = useIsMutating({ mutationKey });
  const mutation = useMutation({
    mutationKey,
    scope: { id: `image-plaza-like:${workId}` },
    retry: false,
    mutationFn: (liked: boolean) =>
      apiClient<SetImagePlazaLikeData>(`/api/image-plaza/works/${workId}/like`, {
        method: 'PUT',
        body: JSON.stringify({ liked }),
        signal: AbortSignal.timeout(10_000),
      }),
    onMutate: async (liked) => {
      await Promise.all([
        client.cancelQueries({ queryKey: imagePlazaKeys.work(workId) }),
        client.cancelQueries({ queryKey: [...imagePlazaKeys.all, 'feed'] }),
      ]);
      const snapshots = patchImagePlazaLike(client, workId, (work) => ({
        liked,
        like_count: Math.max(0, work.like_count + Number(liked) - Number(work.liked)),
      }));
      void client.invalidateQueries({
        queryKey: [...imagePlazaKeys.all, 'feed'],
        refetchType: 'none',
      });
      return snapshots;
    },
    onSuccess: (data) => {
      patchImagePlazaLike(client, workId, () => data);
    },
    onError: async (error, _liked, snapshots) => {
      restoreImagePlazaLike(client, workId, snapshots ?? []);
      if (!(error instanceof ApiClientError) || error.status >= 500) {
        // A timed-out write may have committed. One bounded detail read reconciles the outcome.
        await client
          .fetchQuery({
            queryKey: imagePlazaKeys.work(workId),
            queryFn: () =>
              apiClient<GetImagePlazaWorkData>(`/api/image-plaza/works/${workId}`, {
                signal: AbortSignal.timeout(10_000),
              }),
            staleTime: 0,
            retry: false,
          })
          .then(({ work }) =>
            patchImagePlazaLike(client, workId, () => ({
              liked: work.liked,
              like_count: work.like_count,
            }))
          )
          .catch(() => undefined);
      } else if ([401, 403, 404].includes(error.status)) {
        void client.invalidateQueries({ queryKey: imagePlazaKeys.work(workId) });
      }
    },
    onSettled: () => {
      // Keep cards stationary; the feed must restart from page one before continuing pagination.
      void client.invalidateQueries({
        queryKey: [...imagePlazaKeys.all, 'feed'],
        refetchType: 'none',
      });
    },
  });
  return {
    ...mutation,
    isPending: pending > 0 || mutation.isPending,
    mutate: (liked: boolean) => {
      if (client.isMutating({ mutationKey }) === 0) mutation.mutate(liked);
    },
  };
}

export function useShareImagePlazaMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ShareImagePlazaWorkRequest) =>
      apiClient<ShareImagePlazaWorkData>('/api/image-plaza/share', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: imagePlazaKeys.config() });
      void client.invalidateQueries({ queryKey: [...imagePlazaKeys.all, 'feed'] });
      void client.invalidateQueries({ queryKey: paymentKeys.wallet() });
    },
  });
}

export function validateImagePlazaReference(
  file: File
): UploadImagePlazaReferenceRequest['mime_type'] {
  const mime = file.type;
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
    throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
  }
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20MB');
  if (file.size === 0) throw new Error('图片不能为空');
  return mime;
}

export async function fileToImagePlazaPayload(
  file: File
): Promise<UploadImagePlazaReferenceRequest> {
  const mime = validateImagePlazaReference(file);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onabort = () => reject(new Error('读取图片已取消'));
    reader.readAsDataURL(file);
  });
  return { image_base64: dataUrl.split(',')[1] ?? '', mime_type: mime };
}
