'use client';

import { useQuery } from '@tanstack/react-query';
import type { ApiResponse, GetCharactersData, GetCharacterByIdData } from '@miniapp/shared';

import { apiClient } from './client';

// ==== 纯 fetch 函数（私有，不导出给业务）====
async function fetchCharacters(): Promise<GetCharactersData> {
  const response = await fetch('/api/lobby-characters', { cache: 'no-store' });
  const json = (await response.json().catch(() => null)) as ApiResponse<GetCharactersData> | null;
  if (!response.ok || !json?.success) {
    throw new Error(json && !json.success ? json.error.message : `API error: ${response.status}`);
  }
  persistCharacters(json.data);
  return json.data;
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

// v3 invalidates the old 24-hour snapshots that could hide Admin changes.
const CHARACTER_CACHE_KEY = 'miniapp:lobby-characters:v3';
const CHARACTER_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

function readPersistedCharacters(): GetCharactersData | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(CHARACTER_CACHE_KEY);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as { savedAt?: number; data?: GetCharactersData };
    if (
      !cached.savedAt ||
      Date.now() - cached.savedAt > CHARACTER_CACHE_MAX_AGE_MS ||
      !Array.isArray(cached.data?.characters)
    ) {
      window.localStorage.removeItem(CHARACTER_CACHE_KEY);
      return undefined;
    }
    return cached.data;
  } catch {
    return undefined;
  }
}

function persistCharacters(data: GetCharactersData): void {
  try {
    window.localStorage.setItem(CHARACTER_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // 隐私模式或 quota 满时只使用 React Query 内存缓存。
  }
}

// ==== React Query hooks（业务层唯一入口）====

export function useCharactersQuery() {
  return useQuery<GetCharactersData>({
    queryKey: characterKeys.lists(),
    queryFn: fetchCharacters,
    initialData: readPersistedCharacters,
    // Persisted data keeps the lobby instant, but every mount must reconcile with
    // the database so reordering, delisting, and archival appear immediately.
    staleTime: 0,
    refetchOnMount: 'always',
    gcTime: CHARACTER_CACHE_MAX_AGE_MS,
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
