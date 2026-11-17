'use client';

import type {
  GetImagePlazaConversationData,
  GetVideoPlazaAttemptData,
  GetVideoPlazaPlaybackData,
  ShareVideoPlazaWorkData,
  ShareVideoPlazaWorkRequest,
  SubmitVideoPlazaAttemptData,
  SubmitVideoPlazaAttemptRequest,
  VideoPlazaAttempt,
  VideoPlazaQuoteData,
  VideoPlazaQuoteRequest,
} from '@miniapp/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { apiClient } from './client';
import { paymentKeys } from './payment';

import { imagePlazaKeys } from './image-plaza-keys';

const VIDEO_PLAZA_TERMINAL_STATUSES = new Set<GetVideoPlazaAttemptData['attempt']['status']>([
  'ready',
  'failed',
  'moderation_rejected',
  'expired',
  'failed_unknown',
]);

export function isVideoPlazaAttemptTerminal(
  status: GetVideoPlazaAttemptData['attempt']['status'] | undefined
): boolean {
  return status !== undefined && VIDEO_PLAZA_TERMINAL_STATUSES.has(status);
}

export function videoPlazaQuoteRequestFromAttempt(
  attempt: VideoPlazaAttempt
): VideoPlazaQuoteRequest {
  const { model_id, input_mode, duration_s, resolution, aspect_ratio, audio } = attempt.params;
  return { model_id, input_mode, duration_s, resolution, aspect_ratio, audio };
}

export function mergeVideoAttemptIntoConversationCache(
  client: QueryClient,
  attempt: VideoPlazaAttempt
): void {
  client.setQueryData<GetImagePlazaConversationData>(
    imagePlazaKeys.conversation(attempt.conversation_id),
    (current) => {
      if (!current) return current;
      let changed = false;
      const messages = current.conversation.messages.map((message) => {
        if (message.video_attempt?.id !== attempt.id) return message;
        if (Date.parse(message.video_attempt.updated_at) > Date.parse(attempt.updated_at))
          return message;
        changed = true;
        return { ...message, video_attempt: attempt };
      });
      return changed
        ? {
            conversation: {
              ...current.conversation,
              messages,
              updated_at:
                Date.parse(current.conversation.updated_at) > Date.parse(attempt.updated_at)
                  ? current.conversation.updated_at
                  : attempt.updated_at,
            },
          }
        : current;
    }
  );
}

export function cacheSubmittedVideoAttempt(
  client: QueryClient,
  conversationId: string,
  data: SubmitVideoPlazaAttemptData,
  body: SubmitVideoPlazaAttemptRequest
): boolean {
  const refs = data.message_refs;
  const current = client.getQueryData<GetImagePlazaConversationData>(
    imagePlazaKeys.conversation(conversationId)
  );
  if (!refs || !current) return false;
  if (
    current.conversation.messages.some(
      (message) =>
        message.video_attempt?.id === data.attempt.id ||
        message.id === refs.user.id ||
        message.id === refs.assistant.id
    )
  ) {
    mergeVideoAttemptIntoConversationCache(client, data.attempt);
    return true;
  }
  client.setQueryData<GetImagePlazaConversationData>(imagePlazaKeys.conversation(conversationId), {
    conversation: {
      ...current.conversation,
      messages: [
        ...current.conversation.messages,
        {
          id: refs.user.id,
          role: 'user',
          content: body.prompt,
          media_type: 'video',
          attempt: null,
          video_attempt: null,
          created_at: refs.user.created_at,
        },
        {
          id: refs.assistant.id,
          role: 'assistant',
          content: '视频生成排队中',
          media_type: 'video',
          attempt: null,
          video_attempt: data.attempt,
          created_at: refs.assistant.created_at,
        },
      ],
      updated_at: data.attempt.updated_at,
    },
  });
  return true;
}

export function useVideoPlazaQuoteMutation() {
  return useMutation({
    mutationFn: (body: VideoPlazaQuoteRequest) =>
      apiClient<VideoPlazaQuoteData>('/api/image-plaza/video-quotes', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }),
  });
}

export function useSubmitVideoPlazaAttemptMutation(conversationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SubmitVideoPlazaAttemptRequest) =>
      apiClient<SubmitVideoPlazaAttemptData>(
        `/api/image-plaza/conversations/${conversationId}/video-attempts`,
        { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }
      ),
    onSuccess: (data, body) => {
      const { attempt } = data;
      client.setQueryData<GetVideoPlazaAttemptData>(imagePlazaKeys.videoAttempt(attempt.id), {
        attempt,
      });
      if (!cacheSubmittedVideoAttempt(client, conversationId, data, body))
        void client.invalidateQueries({ queryKey: imagePlazaKeys.conversation(conversationId) });
      void client.invalidateQueries({ queryKey: paymentKeys.wallet() });
    },
  });
}

export function useVideoPlazaAttemptQuery(attemptId: string) {
  const client = useQueryClient();
  const terminalSeen = useRef<string | null>(null);
  const query = useQuery({
    queryKey: imagePlazaKeys.videoAttempt(attemptId),
    queryFn: ({ signal }) =>
      apiClient<GetVideoPlazaAttemptData>(`/api/image-plaza/video-attempts/${attemptId}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
    enabled: Boolean(attemptId),
    staleTime: (query) =>
      isVideoPlazaAttemptTerminal(query.state.data?.attempt.status) ? Infinity : 0,
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
      const status = query.state.data?.attempt.status;
      if (!status || isVideoPlazaAttemptTerminal(status)) return false;
      if (status === 'storing') return 2_000;
      if (status === 'pending' || status === 'submitting') return 3_000;
      return 5_000;
    },
  });
  const { refetch } = query;
  useEffect(() => {
    if (query.data?.attempt) mergeVideoAttemptIntoConversationCache(client, query.data.attempt);
  }, [client, query.data?.attempt]);
  useEffect(() => {
    const status = query.data?.attempt.status;
    if (!status || !isVideoPlazaAttemptTerminal(status) || terminalSeen.current === status) return;
    terminalSeen.current = status;
    void client.invalidateQueries({ queryKey: paymentKeys.wallet() });
  }, [client, query.data?.attempt.status]);
  useEffect(() => {
    const resume = () => {
      if (
        document.visibilityState === 'visible' &&
        attemptId &&
        !isVideoPlazaAttemptTerminal(query.data?.attempt.status)
      )
        void refetch();
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [attemptId, query.data?.attempt.status, refetch]);
  return query;
}

export function useVideoPlazaPlaybackMutation(attemptId: string) {
  return useMutation({
    mutationFn: () =>
      apiClient<GetVideoPlazaPlaybackData>(
        `/api/image-plaza/video-attempts/${attemptId}/playback`,
        { signal: AbortSignal.timeout(10_000) }
      ),
  });
}

export function useShareVideoPlazaMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ShareVideoPlazaWorkRequest) =>
      apiClient<ShareVideoPlazaWorkData>('/api/image-plaza/video-share', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [...imagePlazaKeys.all, 'feed'] });
      void client.invalidateQueries({ queryKey: paymentKeys.wallet() });
    },
  });
}
