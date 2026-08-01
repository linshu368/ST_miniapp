'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetNotificationsData,
  MarkNotificationsReadData,
  MarkNotificationsReadRequest,
  NotificationScope,
  NotificationUnreadCountData,
} from '@miniapp/shared';
import { apiClient } from './client';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (scope: NotificationScope) => ['notifications', 'list', scope] as const,
  unread: ['notifications', 'unread'] as const,
};

// 公告随时可能被运营下架，缓存久了会留在页面上，所以这两个查询都保持短鲜活期。
const NOTIFICATION_POLL_MS = 20_000;

export function useNotificationsQuery(scope: NotificationScope) {
  const query = useQuery({
    queryKey: notificationKeys.list(scope),
    queryFn: () =>
      apiClient<GetNotificationsData>(`/api/notifications?scope=${encodeURIComponent(scope)}`),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: NOTIFICATION_POLL_MS,
  });
  useRefetchOnForeground(query.refetch);
  return query;
}

export function useNotificationUnreadCountQuery() {
  const query = useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () => apiClient<NotificationUnreadCountData>('/api/notifications/unread-count'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: NOTIFICATION_POLL_MS,
  });
  useRefetchOnForeground(query.refetch);
  return query;
}

/**
 * Telegram WebView 里 focus 事件不可靠，小程序被切走再切回来只会触发 visibilitychange，
 * 少了这一下，用户回到前台最多要再等一个轮询周期才看得到新公告的红点。
 */
function useRefetchOnForeground(refetch: () => void): void {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);
}

export function useMarkNotificationsReadMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkNotificationsReadRequest) =>
      apiClient<MarkNotificationsReadData>('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, input) => {
      if (input.scope) {
        client.setQueryData<GetNotificationsData>(notificationKeys.list(input.scope), (current) =>
          current
            ? {
                ...current,
                notifications: current.notifications.map((item) => ({ ...item, is_read: true })),
              }
            : current
        );
      }
      void client.invalidateQueries({ queryKey: notificationKeys.unread });
    },
  });
}
