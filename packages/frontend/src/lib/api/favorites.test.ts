import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { GetCharacterFavoritesData } from '@miniapp/shared';
import { useFavoriteFeedbackStore } from '@/stores/favorite-feedback-store';
import {
  characterSocialKeys,
  patchCharacterFavoriteCount,
  scheduleCharacterSocialRefresh,
} from './character-social';

import {
  favoriteKeys,
  isFavoriteMutationPending,
  rollbackFavoriteIds,
  rollbackFavoriteList,
  scheduleFavoriteRefresh,
} from './favorites';

function character(id: string): GetCharacterFavoritesData['characters'][number] {
  return {
    id,
    name: id,
    description: '',
    avatar_url: '',
    personality_tags: [],
    author_name: '',
    is_featured: false,
  };
}

describe('favorite mutation concurrency', () => {
  it('blocks another click for the same character without blocking other characters', async () => {
    const queryClient = new QueryClient();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: favoriteKeys.mutations(),
      mutationFn: () => pending,
      gcTime: 0,
    });
    const request = mutation.execute({ characterId: 'role-a', favorited: true });

    expect(isFavoriteMutationPending(queryClient, 'role-a')).toBe(true);
    expect(isFavoriteMutationPending(queryClient, 'role-b')).toBe(false);
    release();
    await request;
    expect(isFavoriteMutationPending(queryClient, 'role-a')).toBe(false);
    queryClient.clear();
  });

  it('does not remove a later favorite when another character save fails', () => {
    const previous = { character_ids: ['existing'] };
    const current = { character_ids: ['existing', 'role-a', 'role-b'] };
    expect(rollbackFavoriteIds(current, previous, 'role-a').character_ids).toEqual([
      'existing',
      'role-b',
    ]);
  });

  it('restores a failed unfavorite without losing another character edit', () => {
    const previous = { characters: [character('role-a'), character('existing')] };
    const current = { characters: [character('existing'), character('role-b')] };
    expect(
      rollbackFavoriteList(current, previous, 'role-a').characters.map((item) => item.id)
    ).toEqual(['role-a', 'existing', 'role-b']);
  });

  it('removes only a failed optimistic addition when no previous IDs were cached', () => {
    expect(
      rollbackFavoriteIds({ character_ids: ['role-a', 'role-b'] }, undefined, 'role-a')
    ).toEqual({ character_ids: ['role-b'] });
  });
});

describe('favorite failure feedback recovery', () => {
  it('clears the old failure after that character saves successfully', () => {
    useFavoriteFeedbackStore.setState({ notice: null });
    const store = useFavoriteFeedbackStore.getState();
    store.showFailure('role-a', true);
    expect(useFavoriteFeedbackStore.getState().notice?.characterId).toBe('role-a');
    store.clearForCharacter('role-a');
    expect(useFavoriteFeedbackStore.getState().notice).toBeNull();
  });

  it('keeps a newer failure for another character and ignores the older dismissal timer', () => {
    useFavoriteFeedbackStore.setState({ notice: null });
    const store = useFavoriteFeedbackStore.getState();
    store.showFailure('role-a', true);
    const oldNoticeId = useFavoriteFeedbackStore.getState().notice!.id;
    store.showFailure('role-b', false);
    store.clearForCharacter('role-a');
    store.dismiss(oldNoticeId);
    expect(useFavoriteFeedbackStore.getState().notice?.characterId).toBe('role-b');
    useFavoriteFeedbackStore.setState({ notice: null });
  });
});

describe('favorite final cache refresh', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces simultaneous completions and refreshes after both leave pending', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = (characterId: string) =>
      queryClient
        .getMutationCache()
        .build(queryClient, {
          mutationKey: favoriteKeys.mutations(),
          mutationFn: () => gate,
          onSettled: () => scheduleFavoriteRefresh(queryClient),
          gcTime: Infinity,
        })
        .execute({ characterId, favorited: true });

    const requests = [start('role-a'), start('role-b')];
    release();
    await Promise.all(requests);
    expect(queryClient.isMutating({ mutationKey: favoriteKeys.mutations() })).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      favoriteKeys.ids(),
      favoriteKeys.list(),
    ]);
    queryClient.clear();
  });

  it('waits for the last pending character even when that request fails', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    let releaseFirst = () => {};
    let releaseLast = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const lastGate = new Promise<void>((resolve) => {
      releaseLast = resolve;
    });
    const first = queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationKey: favoriteKeys.mutations(),
        mutationFn: () => firstGate,
        onSettled: () => scheduleFavoriteRefresh(queryClient),
        gcTime: Infinity,
      })
      .execute({ characterId: 'role-a', favorited: true });
    const last = queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationKey: favoriteKeys.mutations(),
        mutationFn: async () => {
          await lastGate;
          throw new Error('request failed');
        },
        onSettled: () => scheduleFavoriteRefresh(queryClient),
        gcTime: Infinity,
      })
      .execute({ characterId: 'role-b', favorited: true });

    releaseFirst();
    await first;
    await vi.runOnlyPendingTimersAsync();
    expect(invalidate).not.toHaveBeenCalled();
    expect(isFavoriteMutationPending(queryClient, 'role-b')).toBe(true);

    const failed = expect(last).rejects.toThrow('request failed');
    releaseLast();
    await failed;
    await vi.runOnlyPendingTimersAsync();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      favoriteKeys.ids(),
      favoriteKeys.list(),
    ]);
    queryClient.clear();
  });
});

describe('character social and favorite concurrency', () => {
  afterEach(() => vi.useRealTimers());

  it('rolls back a favorite count without losing a simultaneous like or new comment', () => {
    const client = new QueryClient();
    client.setQueryData(characterSocialKeys.social('role-a'), {
      liked: true,
      like_count: 129,
      favorite_count: 87,
      comment_count: 24,
    });
    patchCharacterFavoriteCount(client, 'role-a', 86);
    expect(client.getQueryData(characterSocialKeys.social('role-a'))).toEqual({
      liked: true,
      like_count: 129,
      favorite_count: 86,
      comment_count: 24,
    });
    // A missing aggregate remains unknown, not a fabricated zero-count record.
    patchCharacterFavoriteCount(client, 'role-b', 1);
    expect(client.getQueryData(characterSocialKeys.social('role-b'))).toBeUndefined();
    client.clear();
  });

  it('waits for a pending favorite before refreshing a completed like', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = client
      .getMutationCache()
      .build(client, {
        mutationKey: favoriteKeys.mutations(),
        mutationFn: () => gate,
        gcTime: Infinity,
        onSettled: () => scheduleCharacterSocialRefresh(client),
      })
      .execute({ characterId: 'role-a', favorited: true });
    scheduleCharacterSocialRefresh(client);
    await vi.runOnlyPendingTimersAsync();
    expect(invalidate).not.toHaveBeenCalled();
    release();
    await request;
    await vi.runOnlyPendingTimersAsync();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ queryKey: characterSocialKeys.all })
    );
    client.clear();
  });
});
