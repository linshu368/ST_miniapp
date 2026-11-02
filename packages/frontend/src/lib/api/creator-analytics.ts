'use client';

import { useQuery } from '@tanstack/react-query';
import { CreatorAnalyticsDataSchema, type CreatorAnalyticsQuery } from '@miniapp/shared';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { apiClient } from './client';

export function useCreatorAnalyticsQuery(input: Partial<CreatorAnalyticsQuery>, enabled = true) {
  const identity = String(parseTelegramUser(getRawInitData()).id ?? 'local-browser');
  return useQuery({
    queryKey: ['creator-analytics', identity, input],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      Object.entries(input).forEach(([key, value]) => {
        if (value !== undefined) params.set(key, String(value));
      });
      const data = CreatorAnalyticsDataSchema.parse(
        await apiClient<unknown>(`/api/creator/analytics?${params}`, { signal, timeoutMs: 30_000 })
      );
      if (data.section !== (input.section ?? 'overview')) throw new Error('创作数据未正确加载');
      return data;
    },
    // A sort change only reorders works. Keep the same author's reporting scope on screen.
    placeholderData: (previousData, previousQuery) => {
      const previous = previousQuery?.queryKey[2] as Partial<CreatorAnalyticsQuery> | undefined;
      return previousQuery?.queryKey[1] === identity &&
        input.section === 'overview' &&
        previous?.section === 'overview' &&
        previous.period === input.period &&
        previous.character_id === input.character_id &&
        previous.as_of === input.as_of
        ? previousData
        : undefined;
    },
    enabled,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
