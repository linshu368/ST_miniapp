'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CharacterWishDetailDataSchema,
  CharacterWishListDataSchema,
  CharacterWishMutationDataSchema,
  CharacterWishQuerySchema,
  CharacterWishResponseDataSchema,
  CharacterWishWithdrawDataSchema,
  CreateCharacterWishSchema,
  RespondCharacterWishSchema,
  SupportCharacterWishSchema,
  type CharacterWish,
  type CharacterWishDetailData,
  type CharacterWishListData,
  type CharacterWishQuery,
  type CreateCharacterWish,
} from '@miniapp/shared';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { apiClient } from './client';

function wishIdentity() {
  return String(parseTelegramUser(getRawInitData()).id ?? 'local-browser');
}
export const characterWishKeys = {
  all: (identity = wishIdentity()) => ['character-wishes', identity] as const,
  list: (query: CharacterWishQuery, identity = wishIdentity()) =>
    [...characterWishKeys.all(identity), 'list', query] as const,
  detail: (id: string, identity = wishIdentity()) =>
    [...characterWishKeys.all(identity), 'detail', id] as const,
};

export function useCharacterWishesQuery(input: Partial<CharacterWishQuery> = {}) {
  const query = CharacterWishQuerySchema.parse(input);
  const identity = wishIdentity();
  return useQuery({
    queryKey: characterWishKeys.list(query, identity),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams(
        Object.entries(query).map(([key, value]) => [key, String(value)])
      );
      return CharacterWishListDataSchema.parse(
        await apiClient(`/api/character-wishes?${params}`, { signal, queuePriority: 'critical' })
      );
    },
    // Reordering keeps the current cards on screen; changing viewer or list scope must never reuse them.
    placeholderData: (previousData, previousQuery) => {
      const previous = previousQuery?.queryKey[3] as CharacterWishQuery | undefined;
      return previousQuery?.queryKey[1] === identity && previous?.scope === query.scope
        ? previousData
        : undefined;
    },
    staleTime: 20_000,
    retry: false,
  });
}

export function useCharacterWishQuery(id?: string) {
  return useQuery({
    queryKey: characterWishKeys.detail(id ?? ''),
    queryFn: async ({ signal }) =>
      CharacterWishDetailDataSchema.parse(
        await apiClient(`/api/character-wishes/${encodeURIComponent(id!)}`, {
          signal,
          queuePriority: 'critical',
        })
      ),
    enabled: Boolean(id),
    staleTime: 20_000,
    retry: false,
  });
}

function useWishCache() {
  const client = useQueryClient();
  const identity = wishIdentity();
  return {
    refresh: () => client.invalidateQueries({ queryKey: characterWishKeys.all(identity) }),
    update: (wish: CharacterWish) => {
      client.setQueryData<CharacterWishDetailData>(
        characterWishKeys.detail(wish.id, identity),
        (previous) => (previous ? { ...previous, wish } : undefined)
      );
      client.setQueriesData<CharacterWishListData>(
        { queryKey: [...characterWishKeys.all(identity), 'list'] },
        (previous) =>
          previous
            ? {
                ...previous,
                items: previous.items.map((item) => (item.id === wish.id ? wish : item)),
              }
            : undefined
      );
      void client.invalidateQueries({ queryKey: characterWishKeys.all(identity) });
    },
  };
}

export function useCreateCharacterWishMutation() {
  const cache = useWishCache();
  return useMutation({
    retry: false,
    mutationFn: async (input: CreateCharacterWish) =>
      CharacterWishMutationDataSchema.parse(
        await apiClient('/api/character-wishes', {
          method: 'POST',
          body: JSON.stringify(CreateCharacterWishSchema.parse(input)),
        })
      ),
    onSuccess: () => {
      void cache.refresh();
    },
  });
}

export function useSupportCharacterWishMutation() {
  const cache = useWishCache();
  return useMutation({
    retry: false,
    mutationFn: async ({ id, supported }: { id: string; supported: boolean }) =>
      CharacterWishMutationDataSchema.parse(
        await apiClient(`/api/character-wishes/${encodeURIComponent(id)}/support`, {
          method: 'PUT',
          body: JSON.stringify(SupportCharacterWishSchema.parse({ supported })),
        })
      ),
    onSuccess: ({ wish }) => cache.update(wish),
  });
}

export function useWithdrawCharacterWishMutation() {
  const cache = useWishCache();
  return useMutation({
    retry: false,
    mutationFn: async (id: string) =>
      CharacterWishWithdrawDataSchema.parse(
        await apiClient(`/api/character-wishes/${encodeURIComponent(id)}`, { method: 'DELETE' })
      ),
    onSuccess: () => {
      void cache.refresh();
    },
  });
}

export function useRespondCharacterWishMutation() {
  const cache = useWishCache();
  return useMutation({
    retry: false,
    mutationFn: async ({ id, characterId }: { id: string; characterId: string }) =>
      CharacterWishResponseDataSchema.parse(
        await apiClient(`/api/character-wishes/${encodeURIComponent(id)}/responses`, {
          method: 'POST',
          body: JSON.stringify(RespondCharacterWishSchema.parse({ character_id: characterId })),
        })
      ),
    onSuccess: () => {
      void cache.refresh();
    },
  });
}
