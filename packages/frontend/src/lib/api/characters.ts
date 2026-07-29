'use client';

import { useQuery } from '@tanstack/react-query';
import { DEFAULT_LOBBY_SORT } from '@miniapp/shared';
import type {
  ApiResponse,
  GetCharactersData,
  GetCharacterByIdData,
  LobbySort,
} from '@miniapp/shared';

import { apiClient } from './client';

// ==== 纯 fetch 函数（私有，不导出给业务）====
async function fetchCharacters(sort: LobbySort): Promise<GetCharactersData> {
  const response = await fetch(`/api/lobby-characters?sort=${sort}`, { cache: 'no-store' });
  const json = (await response.json().catch(() => null)) as ApiResponse<GetCharactersData> | null;
  if (!response.ok || !json?.success) {
    throw new Error(json && !json.success ? json.error.message : `API error: ${response.status}`);
  }
  persistCharacters(sort, json.data);
  return json.data;
}

async function fetchCharacterById(id: string): Promise<GetCharacterByIdData> {
  return apiClient<GetCharacterByIdData>(`/api/characters/${id}`);
}

// ==== Query Keys ====
export const characterKeys = {
  all: ['characters'] as const,
  lists: () => [...characterKeys.all, 'list'] as const,
  list: (sort: LobbySort) => [...characterKeys.all, 'list', sort] as const,
  detail: (id: string) => [...characterKeys.all, 'detail', id] as const,
};

// v4 隔离「推荐 / 最新」两套顺序，并弃用只存单一顺序的 v3 快照。
const CHARACTER_CACHE_KEY_PREFIX = 'miniapp:lobby-characters:v4';
const CHARACTER_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

function cacheKey(sort: LobbySort): string {
  return `${CHARACTER_CACHE_KEY_PREFIX}:${sort}`;
}

function readPersistedCharacters(sort: LobbySort): GetCharactersData | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(cacheKey(sort));
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as { savedAt?: number; data?: GetCharactersData };
    if (
      !cached.savedAt ||
      Date.now() - cached.savedAt > CHARACTER_CACHE_MAX_AGE_MS ||
      !Array.isArray(cached.data?.characters)
    ) {
      window.localStorage.removeItem(cacheKey(sort));
      return undefined;
    }
    return cached.data;
  } catch {
    return undefined;
  }
}

function persistCharacters(sort: LobbySort, data: GetCharactersData): void {
  try {
    window.localStorage.setItem(cacheKey(sort), JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // 隐私模式或 quota 满时只使用 React Query 内存缓存。
  }
}

// ==== React Query hooks（业务层唯一入口）====

export function useCharactersQuery(sort: LobbySort = DEFAULT_LOBBY_SORT) {
  return useQuery<GetCharactersData>({
    queryKey: characterKeys.list(sort),
    queryFn: () => fetchCharacters(sort),
    initialData: () => readPersistedCharacters(sort),
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
