'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GetVipStatusData, MarkVipEntryViewedData } from '@miniapp/shared';

import { apiClient } from './client';

export const vipKeys = {
  status: ['vip', 'status'] as const,
};

export function useVipStatusQuery() {
  return useQuery({
    queryKey: vipKeys.status,
    queryFn: () => apiClient<GetVipStatusData>('/api/vip/status'),
    staleTime: 15_000,
  });
}

export function useMarkVipEntryViewedMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<MarkVipEntryViewedData>('/api/vip/entry-viewed', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: (status) => {
      client.setQueryData(vipKeys.status, status);
    },
  });
}
