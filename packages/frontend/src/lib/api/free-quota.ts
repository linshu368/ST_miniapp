'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetCharacterFreeQuotaData } from '@miniapp/shared';
import { apiClient } from './client';

export const freeQuotaKeys = {
  detail: (characterId: string) => ['character-free-quota', characterId] as const,
};

export function useCharacterFreeQuotaQuery(
  characterId: string | undefined,
  options: { enabled?: boolean } = {}
) {
  return useQuery<GetCharacterFreeQuotaData>({
    queryKey: characterId ? freeQuotaKeys.detail(characterId) : ['character-free-quota'],
    enabled: !!characterId && options.enabled !== false,
    queryFn: async () => {
      if (!characterId) throw new Error('character id is required');
      return apiClient<GetCharacterFreeQuotaData>(
        `/api/wallet/free-quota/${encodeURIComponent(characterId)}`
      );
    },
    staleTime: 30_000,
  });
}
