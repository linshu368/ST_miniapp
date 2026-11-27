'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
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
import type { RequestPriority } from './request-concurrency';
import { useRefetchOnForeground } from './use-refetch-on-foreground';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (scope: NotificationScope) => ['notifications', 'list', scope] as const,
  detail: (id: string) => ['notifications', 'detail', id] as const,
  unread: ['notifications', 'unread'] as const,
};

// 公告随时可能被运营下架，缓存久了会留在页面上，所以这两个查询都保持短鲜活期。
const NOTIFICATION_POLL_MS = 20_000;

function notificationListQueryOptions(
  scope: NotificationScope,
  priority: RequestPriority = 'critical'
) {
  return {
    queryKey: notificationKeys.list(scope),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiClient<GetNotificationsData>(`/api/notifications?scope=${encodeURIComponent(scope)}`, {
        signal,
        queuePriority: priority,
      }),
    staleTime: 0,
    refetchOnMount: 'always' as const,
    refetchInterval: NOTIFICATION_POLL_MS,
  };
}

export function useNotificationsQuery(scope: NotificationScope) {
  const query = useQuery(notificationListQueryOptions(scope));
  useRefetchOnForeground(query.refetch);
  return query;
}

export function prefetchNotifications(client: QueryClient, scope: NotificationScope) {
  return client.prefetchQuery(notificationListQueryOptions(scope, 'background'));
}

/**
 * `poll: false` 给与 BottomNav 同屏的读者用：React Query 每个 observer 各起一个 interval，
 * 相位不同就各自发请求，同一 key 不会自动合并。BottomNav 在 (main) 下常驻（隐藏时 hooks 也在跑），
 * 由它负责轮询与回前台刷新；其他读者只订阅缓存，进页时仍刷新一次，红点延迟不变。
 */
export function useNotificationUnreadCountQuery({
  poll = true,
  enabled = true,
}: { poll?: boolean; enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: notificationKeys.unread,
    queryFn: ({ signal }) =>
      apiClient<NotificationUnreadCountData>('/api/notifications/unread-count', {
        queuePriority: 'background',
        signal,
      }),
    enabled,
    staleTime: 30_000,
    refetchOnMount: 'always',
    refetchInterval: poll ? NOTIFICATION_POLL_MS : false,
  });
  useRefetchOnForeground(query.refetch, poll && enabled);
  return query;
}

export function useNotificationDetailQuery(id: string | undefined) {
  return useQuery({
    queryKey: id ? notificationKeys.detail(id) : ['notifications', 'detail'],
    enabled: Boolean(id),
    queryFn: ({ signal }) => {
      if (!id) throw new Error('notification id is required');
      return apiClient<GetNotificationDetailData>(`/api/notifications/${encodeURIComponent(id)}`, {
        signal,
        queuePriority: 'critical',
      });
    },
    staleTime: 0,
    retry: false,
  });
}

const NOTIFICATION_SCOPES: NotificationScope[] = ['official', 'personal'];

interface AllReadSnapshot {
  scope: NotificationScope;
  list: GetNotificationsData | undefined;
  unread: NotificationUnreadCountData | undefined;
}

/** 「全部已读」先改缓存让红点立刻消失；先取消进行中的轮询，免得旧结果把红点刷回来。 */
async function applyAllReadOptimistically(
  client: QueryClient,
  scope: NotificationScope
): Promise<AllReadSnapshot> {
  await Promise.all([
    client.cancelQueries({ queryKey: notificationKeys.list(scope) }),
    client.cancelQueries({ queryKey: notificationKeys.unread }),
  ]);
  const list = client.getQueryData<GetNotificationsData>(notificationKeys.list(scope));
  const unread = client.getQueryData<NotificationUnreadCountData>(notificationKeys.unread);
  if (list) {
    client.setQueryData<GetNotificationsData>(notificationKeys.list(scope), {
      ...list,
      notifications: list.notifications.map((item) =>
        item.is_read ? item : { ...item, is_read: true }
      ),
    });
  }
  if (unread) {
    client.setQueryData<NotificationUnreadCountData>(
      notificationKeys.unread,
      subtractUnread(unread, {
        official: scope === 'official' ? unread.official : 0,
        personal: scope === 'personal' ? unread.personal : 0,
      })
    );
  }
  return { scope, list, unread };
}

export function useMarkNotificationsReadMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkNotificationsReadRequest) =>
      apiClient<MarkNotificationsReadData>('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onMutate: (input): Promise<AllReadSnapshot | undefined> =>
      input.all && input.scope
        ? applyAllReadOptimistically(client, input.scope)
        : Promise.resolve(undefined),
    onError: (_error, _input, snapshot) => {
      if (!snapshot) return;
      if (snapshot.list) client.setQueryData(notificationKeys.list(snapshot.scope), snapshot.list);
      if (snapshot.unread) client.setQueryData(notificationKeys.unread, snapshot.unread);
    },
    onSuccess: (_data, input) => {
      if (input.all) {
        void client.invalidateQueries({ queryKey: notificationKeys.unread });
        return;
      }
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
