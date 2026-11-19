'use client';

import type {
  CreateImagePlazaConversationData,
  CreateImagePlazaConversationRequest,
  CreateVideoReferenceFromImageArtifactData,
  GetImagePlazaConfigData,
  GetImagePlazaConversationData,
  GetImagePlazaConversationsData,
  GetImagePlazaFeedData,
  GetImagePlazaWorkData,
  GetVideoPlazaAttemptData,
  GetVideoPlazaTagCountsData,
  ImagePlazaFeedSort,
  ImagePlazaQuoteData,
  ImagePlazaQuoteRequest,
  PlazaWork,
  SetImagePlazaLikeData,
  ShareImagePlazaWorkData,
  ShareImagePlazaWorkRequest,
  SubmitImagePlazaAttemptData,
  SubmitImagePlazaAttemptRequest,
  UploadImagePlazaReferenceData,
  UploadImagePlazaReferenceRequest,
} from '@miniapp/shared';
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type QueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { apiClient, ApiClientError } from './client';
import { paymentKeys } from './payment';

import { imagePlazaKeys } from './image-plaza-keys';
export { imagePlazaKeys } from './image-plaza-keys';
export * from './video-plaza';

export {
  IMAGE_PLAZA_FEED_STALE_TIME_MS,
  useImagePlazaFeedQuery,
  prefetchImagePlazaFeed,
  prefetchImagePlazaConfig,
} from './image-plaza-feed';
export function useImagePlazaConfigQuery({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: imagePlazaKeys.config(),
    queryFn: ({ signal }) =>
      apiClient<GetImagePlazaConfigData>('/api/image-plaza/config', { signal }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useImagePlazaWorkQuery(id: string) {
  return useQuery<GetImagePlazaWorkData>({
    queryKey: imagePlazaKeys.work(id),
    queryFn: ({ signal }) =>
      apiClient<GetImagePlazaWorkData>(`/api/image-plaza/works/${id}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
    enabled: Boolean(id),
    staleTime: 60_000,
    // Upstream also seeds placeholderData from feed cards; this branch's PlazaFeedItem
    // omits snapshot/detail fields, so feed reuse would break detail first paint.
    retry: false,
  });
}

export function useImagePlazaTagCountsQuery(
  search: string,
  media: 'all' | 'image' | 'video',
  enabled = true
) {
  return useQuery({
    queryKey: imagePlazaKeys.tagCounts(search, media),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ media });
      if (search.trim()) params.set('search', search.trim());
      return apiClient<GetVideoPlazaTagCountsData>(
        `/api/image-plaza/feed/tag-counts?${params.toString()}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }
      );
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useImagePlazaConversationsQuery() {
  return useQuery({
    queryKey: imagePlazaKeys.conversations(),
    queryFn: ({ signal }) =>
      apiClient<GetImagePlazaConversationsData>('/api/image-plaza/conversations', { signal }),
    retry: false,
  });
}

export function useImagePlazaConversationQuery(id: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: imagePlazaKeys.conversation(id),
    queryFn: async ({ signal }) => {
      const next = await apiClient<GetImagePlazaConversationData>(
        `/api/image-plaza/conversations/${id}?include_video=1`,
        { signal }
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
      for (const { video_attempt: attempt } of next.conversation.messages) {
        if (!attempt) continue;
        client.setQueryData<GetVideoPlazaAttemptData>(
          imagePlazaKeys.videoAttempt(attempt.id),
          (current) =>
            !current || Date.parse(attempt.updated_at) >= Date.parse(current.attempt.updated_at)
              ? { attempt }
              : current
        );
      }
      return next;
    },
    enabled: Boolean(id),
    retry: false,
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

export function useCreateVideoReferenceFromImageArtifactMutation() {
  return useMutation({
    retry: false,
    mutationFn: (artifactId: string) =>
      apiClient<CreateVideoReferenceFromImageArtifactData>(
        `/api/image-plaza/image-artifacts/${artifactId}/video-reference`,
        { method: 'POST', signal: AbortSignal.timeout(15_000) }
      ),
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

type LikeFields = Pick<PlazaWork, 'liked' | 'like_count'>;
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
