'use client';

import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  CharacterSocial,
  CreateCharacterComment,
  CreateCharacterCommentData,
  GetCharacterCommentsData,
  GetCharacterSocialData,
  GetCharacterSocialsData,
} from '@miniapp/shared';

import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { apiClient } from './client';

function viewerScope() {
  return typeof window === 'undefined'
    ? 'local'
    : String(parseTelegramUser(getRawInitData()).id ?? 'local');
}

export const characterSocialKeys = {
  all: ['character-social'] as const,
  viewer: () => ['character-social', viewerScope()] as const,
  social: (id: string) => [...characterSocialKeys.viewer(), 'social', id] as const,
  batch: (ids: string[]) => [...characterSocialKeys.viewer(), 'batch', ...ids] as const,
  comments: (id: string) => [...characterSocialKeys.viewer(), 'comments', id] as const,
  like: (id: string) => [...characterSocialKeys.viewer(), 'like', id] as const,
};

function hasSocialWrite(client: QueryClient, id?: string) {
  return (
    client.isMutating({
      predicate: (entry) => {
        const key = entry.options.mutationKey;
        if (key?.at(-1) === 'report') return false;
        if (key?.[0] === 'character-social') return !id || key.includes(id);
        if (key?.[0] !== 'character-favorites') return false;
        const input = entry.state.variables;
        return (
          !id ||
          (typeof input === 'object' &&
            input !== null &&
            'characterId' in input &&
            input.characterId === id)
        );
      },
    }) > 0
  );
}

const refreshes = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/** Refetch after the last write settles, so a slow read cannot undo another optimistic action. */
export function scheduleCharacterSocialRefresh(client: QueryClient) {
  const previous = refreshes.get(client);
  if (previous !== undefined) clearTimeout(previous);
  refreshes.set(
    client,
    setTimeout(() => {
      refreshes.delete(client);
      if (!hasSocialWrite(client))
        void client.invalidateQueries({
          queryKey: characterSocialKeys.all,
          predicate: (query) => query.queryKey[2] !== 'comments',
        });
    }, 0)
  );
}

export async function cancelCharacterSocialReads(client: QueryClient) {
  await client.cancelQueries({
    queryKey: characterSocialKeys.all,
    predicate: (query) => query.queryKey[2] !== 'comments',
  });
}

export function patchCharacterFavoriteCount(client: QueryClient, id: string, value: number) {
  client.setQueryData<CharacterSocial>(characterSocialKeys.social(id), (current) =>
    current ? { ...current, favorite_count: Math.max(0, value) } : current
  );
}

export function useCharacterSocialQuery(id: string, enabled = true) {
  const client = useQueryClient();
  const key = characterSocialKeys.social(id);
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const { social } = await apiClient<GetCharacterSocialData>(
        `/api/characters/${encodeURIComponent(id)}/social`,
        { signal, timeoutMs: 8000, queuePriority: 'normal' }
      );
      return hasSocialWrite(client, id)
        ? (client.getQueryData<CharacterSocial>(key) ?? social)
        : social;
    },
    enabled: enabled && Boolean(id),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Cards only observe individual caches; a gallery loads counts in bounded batches after its content. */
export function useCharacterSocialsQuery(ids: string[], enabled = true) {
  const client = useQueryClient();
  const unique = [...new Set(ids)].sort();
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 40) batches.push(unique.slice(i, i + 40));
  return useQueries({
    queries: batches.map((batch) => ({
      queryKey: characterSocialKeys.batch(batch),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const result = await apiClient<GetCharacterSocialsData>(
          `/api/characters/social?ids=${batch.join(',')}`,
          { signal, timeoutMs: 8000, queuePriority: 'normal' }
        );
        if (!signal.aborted) {
          for (const { character_id, ...social } of result.socials) {
            if (!hasSocialWrite(client, character_id))
              client.setQueryData(characterSocialKeys.social(character_id), social);
          }
        }
        return result;
      },
      enabled: enabled && batch.length > 0,
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });
}

export function useCharacterLikeToggle(id: string) {
  const client = useQueryClient();
  const social = useCharacterSocialQuery(id, false);
  const key = characterSocialKeys.social(id);
  const mutationKey = characterSocialKeys.like(id);
  const pending = useIsMutating({ mutationKey });
  const attempts = useMutationState({
    filters: { mutationKey },
    select: (entry) => entry.state.status,
  });
  const mutation = useMutation({
    mutationKey,
    mutationFn: (liked: boolean) =>
      apiClient<GetCharacterSocialData>(`/api/characters/${encodeURIComponent(id)}/like`, {
        method: 'PUT',
        body: JSON.stringify({ liked }),
        timeoutMs: 8000,
      }),
    onMutate: async (liked) => {
      await cancelCharacterSocialReads(client);
      const previous = client.getQueryData<CharacterSocial>(key);
      if (previous)
        client.setQueryData<CharacterSocial>(key, {
          ...previous,
          liked,
          like_count: Math.max(
            0,
            previous.like_count + (liked === previous.liked ? 0 : liked ? 1 : -1)
          ),
        });
      return { previous };
    },
    onSuccess: ({ social: result }) => {
      // Other actions may have changed favorites/comments while this request was in flight.
      client.setQueryData<CharacterSocial>(key, (current) =>
        current ? { ...current, liked: result.liked, like_count: result.like_count } : result
      );
    },
    onError: (_error, _liked, context) => {
      if (context?.previous)
        client.setQueryData<CharacterSocial>(key, (current) =>
          current
            ? {
                ...current,
                liked: context.previous!.liked,
                like_count: context.previous!.like_count,
              }
            : context.previous
        );
    },
    onSettled: () => scheduleCharacterSocialRefresh(client),
    retry: false,
  });
  return {
    liked: social.data?.liked ?? false,
    pending: pending > 0 || !social.data,
    error: attempts.at(-1) === 'error' ? '点赞没能保存，请再试一次' : null,
    toggle: () => {
      if (!id || !social.data || client.isMutating({ mutationKey }) > 0) return;
      mutation.mutate(!social.data.liked);
    },
  };
}

export function useCharacterCommentsQuery(id: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: characterSocialKeys.comments(id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiClient<GetCharacterCommentsData>(
        `/api/characters/${encodeURIComponent(id)}/comments${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal, timeoutMs: 8000, queuePriority: 'normal' }
      ),
    getNextPageParam: (last) => last.next_cursor,
    enabled: enabled && Boolean(id),
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

export function useCharacterCommentMutations(id: string) {
  const client = useQueryClient();
  const prefix = `/api/characters/${encodeURIComponent(id)}/comments`;
  const refreshComments = () => {
    void client.invalidateQueries({ queryKey: characterSocialKeys.comments(id) });
    scheduleCharacterSocialRefresh(client);
  };
  const create = useMutation({
    mutationKey: [...characterSocialKeys.comments(id), 'create'],
    mutationFn: (body: CreateCharacterComment) =>
      apiClient<CreateCharacterCommentData>(prefix, {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: 8000,
      }),
    onSettled: refreshComments,
    retry: false,
  });
  const remove = useMutation({
    mutationKey: [...characterSocialKeys.comments(id), 'remove'],
    mutationFn: (commentId: string) =>
      apiClient<{ deleted: boolean }>(`${prefix}/${encodeURIComponent(commentId)}`, {
        method: 'DELETE',
        timeoutMs: 8000,
      }),
    onSettled: refreshComments,
    retry: false,
  });
  const report = useMutation({
    mutationKey: [...characterSocialKeys.comments(id), 'report'],
    mutationFn: ({
      commentId,
      reason,
    }: {
      commentId: string;
      reason: 'inappropriate' | 'spam' | 'other';
    }) =>
      apiClient<{ reported: boolean }>(`${prefix}/${encodeURIComponent(commentId)}/report`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
        timeoutMs: 8000,
      }),
    retry: false,
  });
  return { create, remove, report };
}
