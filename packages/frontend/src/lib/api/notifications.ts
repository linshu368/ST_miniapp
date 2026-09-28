'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetNotificationDetailData,
  GetNotificationsData,
  MarkNotificationsReadData,
  MarkNotificationsReadRequest,
  NotificationScope,
  NotificationUnreadCountData,
} from '@miniapp/shared';
import { applyReadToNotifications, subtractUnread } from '@/lib/notifications/read-state';
import { apiClient } from './client';
import { useRefetchOnForeground } from './use-refetch-on-foreground';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (scope: NotificationScope) => ['notifications', 'list', scope] as const,
  detail: (id: string) => ['notifications', 'detail', id] as const,
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

export function useNotificationDetailQuery(id: string | undefined) {
  return useQuery({
    queryKey: id ? notificationKeys.detail(id) : ['notifications', 'detail'],
    enabled: Boolean(id),
    queryFn: () => {
      if (!id) throw new Error('notification id is required');
      return apiClient<GetNotificationDetailData>(`/api/notifications/${encodeURIComponent(id)}`);
    },
    staleTime: 0,
    retry: false,
  });
}

const NOTIFICATION_SCOPES: NotificationScope[] = ['official', 'personal'];

export function useMarkNotificationsReadMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkNotificationsReadRequest) =>
      apiClient<MarkNotificationsReadData>('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, input) => {
      const ids = (input.ids ?? []).filter((id) => id.length > 0);
      if (ids.length === 0) {
        void client.invalidateQueries({ queryKey: notificationKeys.unread });
        return;
      }
      const idSet = new Set(ids);
      const newlyRead = { official: 0, personal: 0 };
      let found = 0;
      for (const scope of NOTIFICATION_SCOPES) {
        const current = client.getQueryData<GetNotificationsData>(notificationKeys.list(scope));
        if (!current) continue;
        const applied = applyReadToNotifications(current.notifications, idSet);
        found += applied.newlyReadIds.length;
        newlyRead[scope] += applied.newlyReadIds.length;
        client.setQueryData<GetNotificationsData>(notificationKeys.list(scope), {
          ...current,
          notifications: applied.items,
        });
      }
      for (const id of ids) {
        const current = client.getQueryData<GetNotificationDetailData>(notificationKeys.detail(id));
        if (!current) continue;
        client.setQueryData<GetNotificationDetailData>(notificationKeys.detail(id), {
          notification: { ...current.notification, is_read: true },
        });
      }
      if (found === 0) {
        void client.invalidateQueries({ queryKey: notificationKeys.unread });
        return;
      }
      client.setQueryData<NotificationUnreadCountData>(notificationKeys.unread, (current) =>
        current ? subtractUnread(current, newlyRead) : current
      );
      if (found < ids.length) {
        void client.invalidateQueries({ queryKey: notificationKeys.unread });
      }
    },
  });
}
