'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
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
  SetImagePlazaLikeData,
  ShareImagePlazaWorkData,
  ShareImagePlazaWorkRequest,
  SubmitImagePlazaAttemptData,
  SubmitImagePlazaAttemptRequest,
  UploadImagePlazaReferenceData,
  UploadImagePlazaReferenceRequest,
} from '@miniapp/shared';
import { apiClient } from './client';

export const imagePlazaKeys = {
  all: ['image-plaza'] as const,
  config: () => [...imagePlazaKeys.all, 'config'] as const,
  feed: (search: string, tag: string) => [...imagePlazaKeys.all, 'feed', search, tag] as const,
  work: (id: string) => [...imagePlazaKeys.all, 'work', id] as const,
  conversations: () => [...imagePlazaKeys.all, 'conversations'] as const,
  conversation: (id: string) => [...imagePlazaKeys.all, 'conversation', id] as const,
  attempt: (id: string) => [...imagePlazaKeys.all, 'attempt', id] as const,
};

export function useImagePlazaConfigQuery() {
  return useQuery({
    queryKey: imagePlazaKeys.config(),
    queryFn: () => apiClient<GetImagePlazaConfigData>('/api/image-plaza/config'),
    staleTime: 60_000,
  });
}

export function useImagePlazaFeedQuery(search: string, tag: string) {
  return useInfiniteQuery<
    GetImagePlazaFeedData,
    Error,
    InfiniteData<GetImagePlazaFeedData, string | undefined>,
    ReturnType<typeof imagePlazaKeys.feed>,
    string | undefined
  >({
    queryKey: imagePlazaKeys.feed(search, tag),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (tag !== 'all') params.set('tag', tag);
      if (pageParam) params.set('cursor', pageParam);
      return apiClient<GetImagePlazaFeedData>(`/api/image-plaza/feed?${params.toString()}`);
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 60_000,
    // 切 tag/搜索时保留上一页结构，避免瀑布流整页卸载再重排闪动
    placeholderData: keepPreviousData,
  });
}

export function useImagePlazaWorkQuery(id: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: imagePlazaKeys.work(id),
    queryFn: () => apiClient<GetImagePlazaWorkData>(`/api/image-plaza/works/${id}`),
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
  return useQuery({
    queryKey: imagePlazaKeys.conversation(id),
    queryFn: () => apiClient<GetImagePlazaConversationData>(`/api/image-plaza/conversations/${id}`),
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
    mutationFn: (body: CreateImagePlazaConversationRequest = {}) =>
      apiClient<CreateImagePlazaConversationData>('/api/image-plaza/conversations', {
        method: 'POST',
        body: JSON.stringify(body),
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
    mutationFn: (body: UploadImagePlazaReferenceRequest) =>
      apiClient<UploadImagePlazaReferenceData>('/api/image-plaza/references', {
        method: 'POST',
        body: JSON.stringify(body),
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

export function useSetImagePlazaLikeMutation(workId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (liked: boolean) =>
      apiClient<SetImagePlazaLikeData>(`/api/image-plaza/works/${workId}/like`, {
        method: 'PUT',
        body: JSON.stringify({ liked }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: imagePlazaKeys.work(workId) });
      void client.invalidateQueries({ queryKey: [...imagePlazaKeys.all, 'feed'] });
    },
  });
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
    },
  });
}

export async function fileToImagePlazaPayload(
  file: File
): Promise<UploadImagePlazaReferenceRequest> {
  const mime = file.type;
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
    throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
  }
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20MB');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
  return { image_base64: dataUrl.split(',')[1] ?? '', mime_type: mime };
}
