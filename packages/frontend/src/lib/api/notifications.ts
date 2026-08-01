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

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (scope: NotificationScope) => ['notifications', 'list', scope] as const,
  unread: ['notifications', 'unread'] as const,
};

export function useNotificationsQuery(scope: NotificationScope) {
  return useQuery({
    queryKey: notificationKeys.list(scope),
    queryFn: () =>
      apiClient<GetNotificationsData>(`/api/notifications?scope=${encodeURIComponent(scope)}`),
    staleTime: 30_000,
  });
}

export function useNotificationUnreadCountQuery() {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () => apiClient<NotificationUnreadCountData>('/api/notifications/unread-count'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
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
