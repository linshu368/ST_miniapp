import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { GetModelTiersData } from '@miniapp/shared';

export function useModelTiersQuery() {
  return useQuery({
    queryKey: ['modelTiers'],
    queryFn: async () => {
      const data = await apiClient<GetModelTiersData>('/api/platform/models');
      return data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
