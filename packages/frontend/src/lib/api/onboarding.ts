'use client';

import { useQuery } from '@tanstack/react-query';
import { UserOnboardingSchema } from '@miniapp/shared';
import { apiClient } from './client';

export function useOnboardingQuery(scope: string, enabled: boolean) {
  return useQuery({
    queryKey: ['onboarding', scope],
    enabled,
    queryFn: async ({ signal }) =>
      UserOnboardingSchema.parse(
        await apiClient('/api/users/onboarding', {
          signal,
          timeoutMs: 5000,
          transportRetry: false,
          queuePriority: 'background',
        })
      ),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
}
