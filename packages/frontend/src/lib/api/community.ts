'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommunityEntryData, VerifyCommunityMembershipData } from '@miniapp/shared';
import { apiClient } from './client';
import { paymentKeys } from './payment';
import { notificationKeys } from './notifications';

export const communityKeys = { entry: ['community', 'entry'] as const };

export function useCommunityEntryQuery() {
  return useQuery({
    queryKey: communityKeys.entry,
    queryFn: () => apiClient<CommunityEntryData>('/api/community/entry'),
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.enabled && query.state.data.claim_status === 'unclaimed' ? 15_000 : false,
  });
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
        void client.invalidateQueries({ queryKey: communityKeys.entry });
        void client.invalidateQueries({ queryKey: paymentKeys.wallet() });
        void client.invalidateQueries({ queryKey: notificationKeys.unread });
      }
    },
  });
}
