'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetNotificationsData,
  MarkNotificationsReadData,
  MarkNotificationsReadRequest,
  NotificationScope,
  NotificationUnreadCountData,
} from '@miniapp/shared';
import { apiClient } from './client';
import { useRefetchOnForeground } from './use-refetch-on-foreground';

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
