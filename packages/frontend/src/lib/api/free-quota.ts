'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetCharacterFreeQuotaData } from '@miniapp/shared';
import { apiClient } from './client';

export const freeQuotaKeys = {
  detail: (characterId: string) => ['character-free-quota', characterId] as const,
};

export function useCharacterFreeQuotaQuery(characterId: string | undefined) {
  return useQuery<GetCharacterFreeQuotaData>({
    queryKey: characterId ? freeQuotaKeys.detail(characterId) : ['character-free-quota'],
    enabled: !!characterId,
    queryFn: async () => {
      if (!characterId) throw new Error('character id is required');
      return apiClient<GetCharacterFreeQuotaData>(
        `/api/wallet/free-quota/${encodeURIComponent(characterId)}`
      );
    },
    staleTime: 0,
  });
}
