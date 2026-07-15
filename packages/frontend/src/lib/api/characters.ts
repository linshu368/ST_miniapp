'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetCharactersData, GetCharacterByIdData } from '@miniapp/shared';

import { apiClient } from './client';

// ==== 纯 fetch 函数（私有，不导出给业务）====
async function fetchCharacters(): Promise<GetCharactersData> {
  return apiClient<GetCharactersData>('/api/characters');
}

async function fetchCharacterById(id: string): Promise<GetCharacterByIdData> {
  return apiClient<GetCharacterByIdData>(`/api/characters/${id}`);
}

// ==== Query Keys ====
export const characterKeys = {
  all: ['characters'] as const,
  lists: () => [...characterKeys.all, 'list'] as const,
  detail: (id: string) => [...characterKeys.all, 'detail', id] as const,
};

// ==== React Query hooks（业务层唯一入口）====

export function useCharactersQuery() {
  return useQuery<GetCharactersData>({
    queryKey: characterKeys.lists(),
    queryFn: async () => {
      return fetchCharacters();
    },
  });
}

export function useCharacterQuery(id: string | undefined) {
  return useQuery<GetCharacterByIdData>({
    queryKey: id ? characterKeys.detail(id) : characterKeys.all,
    enabled: !!id,
    queryFn: async () => {
      if (!id) throw new Error('character id is required');
      return fetchCharacterById(id);
    },
  });
}
