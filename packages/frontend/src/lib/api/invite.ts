'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InviteBindData,
  InviteCenterViewData,
  InviteEntryStatusData,
  InviteStatsData,
} from '@miniapp/shared';
import { apiClient } from './client';

export const inviteKeys = {
  all: ['invite'] as const,
  entryStatus: ['invite', 'entry-status'] as const,
  center: ['invite', 'center'] as const,
  stats: ['invite', 'stats'] as const,
};

/** 邀请入口显隐 + "2200星尘"提醒标签状态（我的页 / 充值页 / 星尘不足弹窗共享缓存）。 */
export function useInviteEntryStatusQuery() {
  return useQuery({
    queryKey: inviteKeys.entryStatus,
    queryFn: () => apiClient<InviteEntryStatusData>('/api/invite/entry-status'),
    staleTime: 60_000,
  });
}

/**
 * 进入邀请中心。POST 带副作用（懒生成邀请码、首次进入落 center_first_entered_at），
 * 但对同一用户幂等且返回值稳定，按查询建模；首次成功后同步刷新入口状态让提醒标签消失。
 */
export function useInviteCenterQuery(enabled: boolean) {
  const client = useQueryClient();
  return useQuery({
    queryKey: inviteKeys.center,
    queryFn: async () => {
      const data = await apiClient<InviteCenterViewData>('/api/invite/center-view', {
        method: 'POST',
      });
      if (data.first_visit) {
        client.setQueryData<InviteEntryStatusData>(inviteKeys.entryStatus, (current) =>
          current ? { ...current, center_entered: true } : current
        );
      }
      return data;
    },
    enabled,
    staleTime: Infinity,
  });
}

/** 邀请数据中心（实时聚合，进入数据中心 Tab 时拉取）。 */
export function useInviteStatsQuery(enabled: boolean) {
  return useQuery({
    queryKey: inviteKeys.stats,
    queryFn: () => apiClient<InviteStatsData>('/api/invite/stats'),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/** 绑定上报（供 providers 的 InviteBindReporter 使用，非组件场景故为纯函数）。 */
export function bindInvite(inviteCode: string) {
  return apiClient<InviteBindData>('/api/invite/bind', {
    method: 'POST',
    body: JSON.stringify({ invite_code: inviteCode }),
  });
}
