'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_LOBBY_SORT } from '@miniapp/shared';
import type {
  ApiResponse,
  GetCharactersData,
  GetCharacterByIdData,
  LobbyLatestBadgeData,
  LobbySort,
} from '@miniapp/shared';

import { apiClient } from './client';
import { useRefetchOnForeground } from './use-refetch-on-foreground';

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
  latestBadge: () => [...characterKeys.all, 'latest-badge'] as const,
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

/**
 * 首页「最新」入口的 New 提醒。判定在服务端，所以离开首页再回来不会重复提示。
 * 不做轮询：上新是运营的低频动作，进页面和切回前台各拉一次就够，也避免和 ST 启动抢资源。
 */
export function useLobbyLatestBadgeQuery() {
  const query = useQuery<LobbyLatestBadgeData>({
    queryKey: characterKeys.latestBadge(),
    queryFn: () => apiClient<LobbyLatestBadgeData>('/api/characters/latest-badge'),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  useRefetchOnForeground(query.refetch);
  return query;
}

export function useMarkLobbyLatestSeenMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<LobbyLatestBadgeData>('/api/characters/latest-seen', { method: 'POST' }),
    // 首屏的查询可能还在飞，不取消的话它回来会把提醒重新点亮。
    onMutate: () => client.cancelQueries({ queryKey: characterKeys.latestBadge() }),
    onSuccess: () => {
      client.setQueryData<LobbyLatestBadgeData>(characterKeys.latestBadge(), { has_new: false });
    },
    // 写失败就宁可让 New 留着：水位线没推进，下次进首页仍该提醒。
    retry: 2,
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
