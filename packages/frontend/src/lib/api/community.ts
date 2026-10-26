'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { CommunityEntryData, VerifyCommunityMembershipData } from '@miniapp/shared';
import { apiClient } from './client';
import { paymentKeys } from './payment';
import { notificationKeys } from './notifications';
import { useRefetchOnForeground } from './use-refetch-on-foreground';

export const communityKeys = { entry: ['community', 'entry'] as const };

export function useCommunityEntryQuery() {
  const query = useQuery({
    queryKey: communityKeys.entry,
    queryFn: () => apiClient<CommunityEntryData>('/api/community/entry'),
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.enabled && query.state.data.claim_status === 'unclaimed' ? 15_000 : false,
  });
  const refreshEnabled = query.data?.enabled === true && query.data.claim_status !== 'rewarded';
  const refetch = query.refetch;
  // 兼容正式版前台刷新hook，不引入dev尚未发布的hook接口改动。
  const refreshEntry = useCallback(() => {
    if (refreshEnabled) void refetch({ cancelRefetch: false });
  }, [refetch, refreshEnabled]);
  useRefetchOnForeground(refreshEntry);
  return query;
}

export function useVerifyCommunityMembershipMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<VerifyCommunityMembershipData>('/api/community/verify-membership', {
        method: 'POST',
      }),
    onSuccess: (data) => {
      if (data.status === 'rewarded' || data.status === 'already_rewarded') {
        client.setQueryData<CommunityEntryData>(communityKeys.entry, (current) =>
          current
            ? { ...current, claim_status: 'rewarded', rewarded_at: data.rewarded_at }
            : current
        );
        void client.invalidateQueries({ queryKey: communityKeys.entry });
        void client.invalidateQueries({ queryKey: paymentKeys.wallet() });
        void client.invalidateQueries({ queryKey: notificationKeys.unread });
      }
    },
  });
}
