'use client';

import { useQuery } from '@tanstack/react-query';
import type { GetCharactersData, GetCharacterByIdData } from '@miniapp/shared';

import { apiClient } from './client';
import { mockCharacters, getMockCharacterDetail } from '@/lib/mock-data';

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

/** 是否使用 mock 数据（当后端未联调时 PM 本地使用）。
 *  切换方式：NEXT_PUBLIC_USE_MOCK=1 的时候启用。
 *  默认 false —— 开发接入后一律走真实接口。 */
const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === '1';

export function useCharactersQuery() {
  return useQuery<GetCharactersData>({
    queryKey: characterKeys.lists(),
    queryFn: async () => {
      if (USE_MOCK) return { characters: mockCharacters };
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
      if (USE_MOCK) {
        const character = getMockCharacterDetail(id);
        if (!character) throw new Error(`mock character not found: ${id}`);
        return { character };
      }
      return fetchCharacterById(id);
    },
  });
}
