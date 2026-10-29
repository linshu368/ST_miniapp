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
    queryFn: ({ signal }) =>
      apiClient<GetSupportConversationData>('/api/support/conversation', { signal }),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * 「我的」页「联系客服」入口和底部导航的红点都读这个。
 * `poll: false` 的含义同 useNotificationUnreadCountQuery：轮询由常驻的 BottomNav 负责。
 */
export function useSupportUnreadQuery({
  poll = true,
  enabled = true,
}: { poll?: boolean; enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: supportKeys.unread,
    queryFn: ({ signal }) =>
      apiClient<SupportUnreadData>('/api/support/unread', {
        queuePriority: 'background',
        signal,
      }),
    enabled,
    staleTime: 30_000,
    // 20s 轮询已经负责活跃页面的新鲜度；重复 observer 挂载时尊重 30s 缓存，
    // 避免 BottomNav 与 Profile 在相邻 commit 中重复打客服代理。
    refetchOnMount: true,
    refetchInterval: poll ? SUPPORT_UNREAD_POLL_MS : false,
  });
  useRefetchOnForeground(query.refetch, poll && enabled);
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
