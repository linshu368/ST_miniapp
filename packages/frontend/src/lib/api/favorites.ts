'use client';

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  CharacterSocial,
  GetCharacterFavoriteIdsData,
  GetCharacterFavoritesData,
  SetCharacterFavoriteData,
} from '@miniapp/shared';

import { useFavoriteFeedbackStore } from '@/stores/favorite-feedback-store';
import { apiClient } from './client';
import {
  cancelCharacterSocialReads,
  characterSocialKeys,
  patchCharacterFavoriteCount,
  scheduleCharacterSocialRefresh,
} from './character-social';

export const favoriteKeys = {
  all: ['character-favorites'] as const,
  ids: () => [...favoriteKeys.all, 'ids'] as const,
  list: () => [...favoriteKeys.all, 'list'] as const,
  mutations: () => [...favoriteKeys.all, 'set'] as const,
};

async function fetchFavoriteIds(): Promise<GetCharacterFavoriteIdsData> {
  return apiClient<GetCharacterFavoriteIdsData>('/api/favorites/ids', { queuePriority: 'normal' });
}

async function fetchFavorites(): Promise<GetCharacterFavoritesData> {
  return apiClient<GetCharacterFavoritesData>('/api/favorites');
}

async function setFavorite(input: {
  characterId: string;
  favorited: boolean;
}): Promise<SetCharacterFavoriteData> {
  return apiClient<SetCharacterFavoriteData>(
    `/api/favorites/${encodeURIComponent(input.characterId)}`,
    { method: input.favorited ? 'PUT' : 'DELETE' }
  );
}

/**
 * 收藏 id 集合是首页、详情弹层和对话页共用的唯一状态源，
 * 任一入口切换后其余入口都会读到同一份缓存。
 *
 * `enabled` 供大厅冷启动延后：收藏心与「只看收藏」不在首屏关键路径上，
 * 与列表争 Railway 连接时会放大超时尖峰。
 */
export function useFavoriteIdsQuery({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<GetCharacterFavoriteIdsData>({
    queryKey: favoriteKeys.ids(),
    queryFn: fetchFavoriteIds,
    staleTime: 30_000,
    enabled,
  });
}

export function useFavoritesQuery() {
  return useQuery<GetCharacterFavoritesData>({
    queryKey: favoriteKeys.list(),
    queryFn: fetchFavorites,
    staleTime: 30_000,
  });
}

interface FavoriteMutationInput {
  characterId: string;
  favorited: boolean;
}

interface FavoriteMutationContext {
  previousIds?: GetCharacterFavoriteIdsData;
  previousList?: GetCharacterFavoritesData;
  previousCount?: number;
}

function matchesCharacter(variables: unknown, characterId: string): boolean {
  return (
    typeof variables === 'object' &&
    variables !== null &&
    'characterId' in variables &&
    variables.characterId === characterId
  );
}

/** Check the shared mutation cache as well as rendered state to catch rapid repeated clicks. */
export function isFavoriteMutationPending(queryClient: QueryClient, characterId: string): boolean {
  return (
    queryClient.isMutating({
      mutationKey: favoriteKeys.mutations(),
      predicate: (mutation) => matchesCharacter(mutation.state.variables, characterId),
    }) > 0
  );
}

function applyFavoriteId(
  current: GetCharacterFavoriteIdsData | undefined,
  characterId: string,
  favorited: boolean
): GetCharacterFavoriteIdsData {
  const ids = new Set(current?.character_ids ?? []);
  if (favorited) ids.add(characterId);
  else ids.delete(characterId);
  return { character_ids: [...ids] };
}

/** A failed write restores only its character; other characters may already have newer edits. */
export function rollbackFavoriteIds(
  current: GetCharacterFavoriteIdsData,
  previous: GetCharacterFavoriteIdsData | undefined,
  characterId: string
): GetCharacterFavoriteIdsData {
  return applyFavoriteId(
    current,
    characterId,
    previous?.character_ids.includes(characterId) ?? false
  );
}

export function rollbackFavoriteList(
  current: GetCharacterFavoritesData,
  previous: GetCharacterFavoritesData | undefined,
  characterId: string
): GetCharacterFavoritesData {
  const previousIndex =
    previous?.characters.findIndex((character) => character.id === characterId) ?? -1;
  const previousCharacter = previousIndex >= 0 ? previous?.characters[previousIndex] : undefined;
  const characters = current.characters.filter((character) => character.id !== characterId);
  if (previousCharacter)
    characters.splice(Math.min(previousIndex, characters.length), 0, previousCharacter);
  return { characters };
}

// Keep this scheduler scoped to favorites and to its QueryClient. Two requests
// can reach onSettled before either has dispatched its terminal mutation state.
const pendingFavoriteRefreshes = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

export function scheduleFavoriteRefresh(queryClient: QueryClient): void {
  const previous = pendingFavoriteRefreshes.get(queryClient);
  if (previous !== undefined) clearTimeout(previous);
  const timer = setTimeout(() => {
    pendingFavoriteRefreshes.delete(queryClient);
    if (queryClient.isMutating({ mutationKey: favoriteKeys.mutations() }) > 0) return;
    void queryClient.invalidateQueries({ queryKey: favoriteKeys.ids() });
    void queryClient.invalidateQueries({ queryKey: favoriteKeys.list() });
  }, 0);
  pendingFavoriteRefreshes.set(queryClient, timer);
}

export function useSetFavoriteMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    SetCharacterFavoriteData,
    Error,
    FavoriteMutationInput,
    FavoriteMutationContext
  >({
    mutationKey: favoriteKeys.mutations(),
    mutationFn: setFavorite,
    onMutate: async (input) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: favoriteKeys.ids() }),
        queryClient.cancelQueries({ queryKey: favoriteKeys.list() }),
        cancelCharacterSocialReads(queryClient),
      ]);

      const previousIds = queryClient.getQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids());
      const previousList = queryClient.getQueryData<GetCharacterFavoritesData>(favoriteKeys.list());
      const previousCount = queryClient.getQueryData<CharacterSocial>(
        characterSocialKeys.social(input.characterId)
      )?.favorite_count;
      if (previousCount !== undefined && previousIds) {
        const wasFavorited = previousIds.character_ids.includes(input.characterId);
        patchCharacterFavoriteCount(
          queryClient,
          input.characterId,
          previousCount + (wasFavorited === input.favorited ? 0 : input.favorited ? 1 : -1)
        );
      }
      queryClient.setQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids(), (current) =>
        applyFavoriteId(current, input.characterId, input.favorited)
      );

      // Removing a favorite is immediate; a new favorite's full summary comes from refetching.
      if (!input.favorited && previousList) {
        queryClient.setQueryData<GetCharacterFavoritesData>(favoriteKeys.list(), {
          characters: previousList.characters.filter(
            (character) => character.id !== input.characterId
          ),
        });
      }
      return { previousIds, previousList, previousCount };
    },
    onSuccess: (data) => {
      queryClient.setQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids(), (current) =>
        applyFavoriteId(current, data.favorite.character_id, data.favorite.favorited)
      );
      useFavoriteFeedbackStore.getState().clearForCharacter(data.favorite.character_id);
    },
    onError: (_error, input, context) => {
      if (context?.previousCount !== undefined) {
        patchCharacterFavoriteCount(queryClient, input.characterId, context.previousCount);
      }
      queryClient.setQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids(), (current) =>
        current ? rollbackFavoriteIds(current, context?.previousIds, input.characterId) : current
      );
      queryClient.setQueryData<GetCharacterFavoritesData>(favoriteKeys.list(), (current) =>
        current ? rollbackFavoriteList(current, context?.previousList, input.characterId) : current
      );
      // This host survives an optimistic removal and its trigger component unmounting.
      useFavoriteFeedbackStore.getState().showFailure(input.characterId, input.favorited);
    },
    onSettled: () => {
      // Do not await this task: mutation state must leave pending before it runs.
      scheduleFavoriteRefresh(queryClient);
      scheduleCharacterSocialRefresh(queryClient);
    },
  });
}

/** Card, detail sheet and chat header share the same character state, pending lock and failure notice. */
export function useFavoriteToggle(characterId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { data } = useFavoriteIdsQuery();
  const mutation = useSetFavoriteMutation();
  const pendingCount = useIsMutating({
    mutationKey: favoriteKeys.mutations(),
    predicate: (entry) =>
      typeof characterId === 'string' && matchesCharacter(entry.state.variables, characterId),
  });
  const error = useFavoriteFeedbackStore((state) =>
    state.notice && state.notice.characterId === characterId ? state.notice.message : null
  );
  const favorited = characterId ? (data?.character_ids.includes(characterId) ?? false) : false;

  return {
    favorited,
    pending: pendingCount > 0,
    error,
    toggle: () => {
      if (!characterId || isFavoriteMutationPending(queryClient, characterId)) return;
      mutation.mutate({ characterId, favorited: !favorited });
    },
  };
}
