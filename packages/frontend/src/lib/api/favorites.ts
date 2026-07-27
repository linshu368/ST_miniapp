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

/**
 * 收藏 id 集合是首页、详情弹层和对话页共用的唯一状态源，
 * 任一入口切换后其余入口都会读到同一份缓存。
 */
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
    // 心形要立刻响应点击，所以先改本地缓存，失败再回滚。
    onMutate: async (input) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: favoriteKeys.ids() }),
        queryClient.cancelQueries({ queryKey: favoriteKeys.list() }),
      ]);

      const previousIds = queryClient.getQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids());
      const previousList = queryClient.getQueryData<GetCharacterFavoritesData>(favoriteKeys.list());

      const nextIds = new Set(previousIds?.character_ids ?? []);
      if (input.favorited) nextIds.add(input.characterId);
      else nextIds.delete(input.characterId);
      queryClient.setQueryData<GetCharacterFavoriteIdsData>(favoriteKeys.ids(), {
        character_ids: [...nextIds],
      });

      // 取消收藏时立即从收藏列表移除；新增收藏需要完整角色卡摘要，交给失效重取。
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
    // 连续点击时以最后一次服务端结果为准。
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: favoriteKeys.ids() });
      void queryClient.invalidateQueries({ queryKey: favoriteKeys.list() });
    },
  });
}

/** 读取单张角色卡的收藏状态与切换动作，三个入口共用。 */
export function useFavoriteToggle(characterId: string | null | undefined) {
  const { data } = useFavoriteIdsQuery();
  const mutation = useSetFavoriteMutation();

  const favorited = characterId ? (data?.character_ids.includes(characterId) ?? false) : false;

  return {
    favorited,
    pending: mutation.isPending,
    toggle: () => {
      if (!characterId) return;
      mutation.mutate({ characterId, favorited: !favorited });
    },
  };
}
