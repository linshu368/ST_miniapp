'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { PublicCreatorSpaceData } from '@miniapp/shared';
import { apiClient } from './client';

export function usePublicCreatorWorks(id: string) {
  return useInfiniteQuery({
    queryKey: ['public-creator', id, 'works'],
    initialPageParam: 1,
    // Recheck publication status when a viewer reopens the space.
    staleTime: 0,
    refetchOnWindowFocus: true,
    queryFn: ({ pageParam, signal }) =>
      apiClient<PublicCreatorSpaceData>(
        `/api/creators/${encodeURIComponent(id)}/characters?page=${pageParam}`,
        { signal }
      ),
    getNextPageParam: (page) => (page.has_more ? page.page + 1 : undefined),
    retry: false,
  });
}
