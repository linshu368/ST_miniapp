'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GetChatFeedbackDataSchema,
  SaveChatFeedbackDataSchema,
  type GetChatFeedbackData,
  type SaveChatFeedbackData,
  type SaveChatFeedbackRequest,
} from '@miniapp/shared';
import { apiClient } from './client';

export interface ChatFeedbackTarget {
  sessionId: string;
  messageId: string;
  version: number;
}
const key = (target: ChatFeedbackTarget) =>
  ['chat-reply-feedback', target.sessionId, target.messageId, target.version] as const;
const path = (target: ChatFeedbackTarget) =>
  `/api/v1/conversations/${encodeURIComponent(target.sessionId)}/messages/${encodeURIComponent(target.messageId)}/feedback`;

export function useChatFeedbackQuery(target: ChatFeedbackTarget, enabled: boolean) {
  return useQuery({
    queryKey: key(target),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () =>
      GetChatFeedbackDataSchema.parse(
        await apiClient<GetChatFeedbackData>(`${path(target)}?edit_version=${target.version}`, {
          timeoutMs: 10_000,
        })
      ),
  });
}
export function useSaveChatFeedbackMutation(target: ChatFeedbackTarget) {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (body: SaveChatFeedbackRequest) =>
      SaveChatFeedbackDataSchema.parse(
        await apiClient<SaveChatFeedbackData>(path(target), {
          method: 'PUT',
          body: JSON.stringify(body),
          timeoutMs: 10_000,
        })
      ),
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey: key(target), exact: true });
      client.setQueryData(key(target), data);
    },
  });
}
