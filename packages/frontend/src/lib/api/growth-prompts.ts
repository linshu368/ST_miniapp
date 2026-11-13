'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  GetGrowthPromptsData,
  GrowthPromptEvent,
  GrowthPromptKind,
  RecordGrowthPromptEventData,
} from '@miniapp/shared';

import { apiClient } from './client';

export const growthPromptKeys = { all: ['growth-prompts'] as const };

/** 每次打开只取一次：轮数增量由本地累加，展示上限由服务端在 shown 时再判一次。 */
export function useGrowthPromptsQuery(enabled: boolean) {
  return useQuery({
    queryKey: growthPromptKeys.all,
    enabled,
    queryFn: ({ signal }) =>
      apiClient<GetGrowthPromptsData>('/api/growth/prompts', {
        signal,
        timeoutMs: 5000,
        transportRetry: false,
        queuePriority: 'background',
      }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
}

/** 只为计数与统计，失败不影响界面；返回 null 表示没记上。 */
export function recordGrowthPromptEvent(
  kind: GrowthPromptKind,
  event: GrowthPromptEvent
): Promise<RecordGrowthPromptEventData | null> {
  return apiClient<RecordGrowthPromptEventData>('/api/growth/prompts/events', {
    method: 'POST',
    body: JSON.stringify({ kind, event }),
    timeoutMs: 5000,
    queuePriority: 'background',
  }).catch(() => null);
}
