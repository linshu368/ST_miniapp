'use client';

import { useQuery } from '@tanstack/react-query';
import type { HealthData } from '@miniapp/shared';
import { apiClient } from './client';

async function fetchHealth(): Promise<HealthData> {
  return apiClient<HealthData>('/health');
}

export const healthKeys = {
  all: ['health'] as const,
};

export function useHealthQuery() {
  return useQuery({
    queryKey: healthKeys.all,
    queryFn: fetchHealth,
    retry: 0,
  });
}
