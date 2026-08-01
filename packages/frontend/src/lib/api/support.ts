'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetSupportConversationData,
  SendSupportMessageData,
  SendSupportMessageRequest,
  SupportUnreadData,
} from '@miniapp/shared';
import { apiClient } from './client';
import { useRefetchOnForeground } from './use-refetch-on-foreground';

// 与消息中心红点保持同一个刷新节奏，两处红点不会一个先亮一个后亮。
const SUPPORT_UNREAD_POLL_MS = 20_000;

export const supportKeys = {
  conversation: ['support', 'conversation'] as const,
  unread: ['support', 'unread'] as const,
};

export function useSupportConversationQuery() {
  return useQuery({
    queryKey: supportKeys.conversation,
    queryFn: () => apiClient<GetSupportConversationData>('/api/support/conversation'),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

/** 「我的」页「联系客服」入口和底部导航的红点都读这个。 */
export function useSupportUnreadQuery() {
  const query = useQuery({
    queryKey: supportKeys.unread,
    queryFn: () => apiClient<SupportUnreadData>('/api/support/unread'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: SUPPORT_UNREAD_POLL_MS,
  });
  useRefetchOnForeground(query.refetch);
  return query;
}

export function useMarkSupportReadMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient<SupportUnreadData>('/api/support/read', { method: 'POST' }),
    onSuccess: () => {
      client.setQueryData<SupportUnreadData>(supportKeys.unread, { has_unread: false });
    },
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
