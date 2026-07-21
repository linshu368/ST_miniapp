'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetCharacterFavoriteIdsData,
  GetCharacterFavoritesData,
  SetCharacterFavoriteData,
} from '@miniapp/shared';
import { apiClient } from './client';

export const favoriteKeys = {
  all: ['character-favorites'] as const,
  ids: () => [...favoriteKeys.all, 'ids'] as const,
  list: () => [...favoriteKeys.all, 'list'] as const,
};

async function fetchFavoriteIds(): Promise<GetCharacterFavoriteIdsData> {
  return apiClient<GetCharacterFavoriteIdsData>('/api/favorites/ids');
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

export function useFavoriteIdsQuery() {
  return useQuery<GetCharacterFavoriteIdsData>({
    queryKey: favoriteKeys.ids(),
    queryFn: fetchFavoriteIds,
    staleTime: 30_000,
  });
}

export function useFavoritesQuery() {
  return useQuery<GetCharacterFavoritesData>({
    queryKey: favoriteKeys.list(),
    queryFn: fetchFavorites,
    staleTime: 30_000,
  });
}

export function useSetFavoriteMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    SetCharacterFavoriteData,
    Error,
    { characterId: string; favorited: boolean },
    { previousIds?: GetCharacterFavoriteIdsData; previousList?: GetCharacterFavoritesData }
  >({
    mutationFn: setFavorite,
    onMutate: async (input) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: favoriteKeys.ids() }),
        queryClient.cancelQueries({ queryKey: favoriteKeys.list() }),
      ]);
      const previousIds = queryClient.getQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids());
      const previousList = queryClient.getQueryData<GetCharacterFavoritesData>(favoriteKeys.list());
      const current = new Set(previousIds?.character_ids ?? []);
      if (input.favorited) current.add(input.characterId);
      else current.delete(input.characterId);
      queryClient.setQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids(), {
        character_ids: [...current],
      });
      if (!input.favorited && previousList) {
        queryClient.setQueryData<GetCharacterFavoritesData>(favoriteKeys.list(), {
          characters: previousList.characters.filter(
            (character) => character.id !== input.characterId
          ),
        });
      }
      return { previousIds, previousList };
    },
    onError: (_error, _input, context) => {
      if (context?.previousIds) {
        queryClient.setQueryData(favoriteKeys.ids(), context.previousIds);
      }
      if (context?.previousList) {
        queryClient.setQueryData(favoriteKeys.list(), context.previousList);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: favoriteKeys.ids() });
      void queryClient.invalidateQueries({ queryKey: favoriteKeys.list() });
    },
  });
}
