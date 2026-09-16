'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateImageDescriptionData,
  CreateMessageImageData,
  CreateMessageImageRequest,
  GetImageConfigData,
  GetSessionImagesData,
  MessageImageAttempt,
  MessageImageState,
} from '@miniapp/shared';
import { apiClient } from './client';
import { paymentKeys } from './payment';

export const imageKeys = {
  config: ['image-config'] as const,
  session: (sessionId: string) => ['images', 'session', sessionId] as const,
};

export function useImageConfigQuery(enabled = true) {
  return useQuery<GetImageConfigData>({
    queryKey: imageKeys.config,
    enabled,
    queryFn: async () => apiClient<GetImageConfigData>('/api/v1/images/config'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSessionImagesQuery(sessionId: string | undefined) {
  return useQuery<GetSessionImagesData>({
    queryKey: imageKeys.session(sessionId ?? ''),
    enabled: Boolean(sessionId),
    queryFn: async () => {
      if (!sessionId) throw new Error('session id is required');
      return apiClient<GetSessionImagesData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}/images`
      );
    },
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.images.some((item) =>
        ['pending', 'generating'].includes(item.latest?.status ?? '')
      )
        ? 1_800
        : false,
  });
}

export function useCreateImageDescriptionMutation(sessionId: string | undefined) {
  return useMutation({
    mutationFn: async (messageId: string) => {
      if (!sessionId) throw new Error('session id is required');
      return apiClient<CreateImageDescriptionData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
          messageId
        )}/image-description`,
        { method: 'POST' }
      );
    },
  });
}

export function useCreateMessageImageMutation(sessionId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { messageId: string; body: CreateMessageImageRequest }) => {
      if (!sessionId) throw new Error('session id is required');
      return apiClient<CreateMessageImageData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
          input.messageId
        )}/image`,
        { method: 'POST', body: JSON.stringify(input.body) }
      );
    },
    onSuccess: (data) => {
      if (!sessionId) return;
      queryClient.setQueryData<GetSessionImagesData>(imageKeys.session(sessionId), (current) =>
        mergeImageAttempt(current, data.attempt)
      );
      void queryClient.invalidateQueries({ queryKey: imageKeys.session(sessionId) });
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
    },
    onError: () => {
      if (!sessionId) return;
      void queryClient.invalidateQueries({ queryKey: imageKeys.session(sessionId) });
    },
  });
}

function mergeImageAttempt(
  current: GetSessionImagesData | undefined,
  attempt: MessageImageAttempt
): GetSessionImagesData {
  const state: MessageImageState = {
    message_id: attempt.message_id,
    current:
      attempt.status === 'ready'
        ? attempt
        : (current?.images.find((x) => x.message_id === attempt.message_id)?.current ?? null),
    latest: attempt,
  };
  const rest = (current?.images ?? []).filter((item) => item.message_id !== attempt.message_id);
  return { images: [...rest, state] };
}

export function toImageMap(data: GetSessionImagesData | undefined): Map<string, MessageImageState> {
  return new Map((data?.images ?? []).map((item) => [item.message_id, item]));
}
