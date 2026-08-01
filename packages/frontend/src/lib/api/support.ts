'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetSupportConversationData,
  SendSupportMessageData,
  SendSupportMessageRequest,
} from '@miniapp/shared';
import { apiClient } from './client';

export const supportKeys = {
  conversation: ['support', 'conversation'] as const,
};

export function useSupportConversationQuery() {
  return useQuery({
    queryKey: supportKeys.conversation,
    queryFn: () => apiClient<GetSupportConversationData>('/api/support/conversation'),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

export function useSendSupportMessageMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SendSupportMessageRequest) =>
      apiClient<SendSupportMessageData>('/api/support/messages', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: supportKeys.conversation }),
  });
}
