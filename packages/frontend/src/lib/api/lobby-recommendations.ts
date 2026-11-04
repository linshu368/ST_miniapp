'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LobbyRecommendationDataSchema,
  LOBBY_ROTATION_HEAD_SIZE,
  type GetCharactersData,
  type LobbySort,
  type LobbyRecommendationData,
  type LobbyRecommendationExposures,
  type LobbyRecommendationExposuresData,
  type LobbyRecommendationRequest,
} from '@miniapp/shared';
import {
  canReuseLobbyBatch,
  checkedLobbyReadFrame,
  createLobbyRequestId,
  lobbyEntryRequest,
  lobbyViewerScope,
  markLobbyVisit,
  needsLobbyHeadCheck,
  projectLobbyOrder,
  readLobbyRecommendation,
  rememberLobbyRecommendation,
} from '@/lib/lobby-recommendation-state';
import { apiClient, ApiClientError } from './client';
import {
  characterKeys,
  readLegacyHeadCards,
  useCharactersQuery,
  usePublicLobbyHead,
} from './characters';
import type { LobbyReturnSnapshot } from '@/lib/lobby-return';

type ReadFrame = ReturnType<typeof checkedLobbyReadFrame>;
const lastReadFrames = new Map<string, ReadFrame>();

export const lobbyRecommendationKeys = {
  viewer: (scope: string) => ['lobby-recommendation', scope] as const,
};

function hasHeadDetails(batch: LobbyRecommendationData, catalogue: GetCharactersData | undefined) {
  if (!batch.enabled || batch.head_ids.length === 0) return true;
  const available = new Set(catalogue?.characters.map((character) => character.id));
  return batch.head_ids.every((id) => available.has(id));
}

async function requestRecommendation(
  body: LobbyRecommendationRequest,
  signal?: AbortSignal
): Promise<LobbyRecommendationData> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  // Includes queueing and body decoding, not only receipt of response headers.
  const timeout = setTimeout(() => controller.abort(new Error('推荐读取超时')), 5000);
  try {
    const fetch = (payload: LobbyRecommendationRequest) =>
      apiClient<unknown>('/api/characters/recommendation', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
        timeoutMs: 5000,
        queuePriority: 'critical',
      });
    const data = await fetch({ ...body, include_head_cards: true }).catch((error: unknown) => {
      // An older strict request schema rejects the opt-in flag before processing the intent.
      if (error instanceof ApiClientError && error.status === 400) return fetch(body);
      throw error;
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    return LobbyRecommendationDataSchema.parse(data);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function useLobbyRecommendation({
  enabled,
  restoreBatchId,
}: {
  enabled: boolean;
  restoreBatchId?: string | null;
}) {
  const client = useQueryClient();
  const scope = lobbyViewerScope();

  const key = useMemo(() => lobbyRecommendationKeys.viewer(scope), [scope]);
  // Re-entering the recommended tab is a new visit; expiry is not a timer on an open list.
  const returningFrame = useMemo(() => {
    const frame = lastReadFrames.get(scope);
    return restoreBatchId && frame?.batch.batch_id === restoreBatchId ? frame : undefined;
  }, [scope, restoreBatchId]);
  const cachedAtEntry = useMemo(
    () => (enabled ? (returningFrame?.batch ?? readLobbyRecommendation(scope)) : undefined),
    [enabled, scope, returningFrame]
  );
  const reuseCached = useMemo(
    () =>
      canReuseLobbyBatch(cachedAtEntry, restoreBatchId) &&
      (cachedAtEntry?.head_cards !== undefined ||
        (cachedAtEntry &&
          hasHeadDetails(cachedAtEntry, client.getQueryData(characterKeys.list('recommended'))))),
    [cachedAtEntry, restoreBatchId, client]
  );
  const visit = useMemo(
    () =>
      enabled
        ? {
            entry: lobbyEntryRequest(scope, restoreBatchId),
            recheck: reuseCached && needsLobbyHeadCheck(scope),
          }
        : undefined,
    [enabled, scope, restoreBatchId, reuseCached]
  );
  const recheck = visit?.recheck;
  const [rechecked, setRechecked] = useState<{ visit: typeof visit; frame: ReadFrame }>();
  const completedEntry = useRef<string>();
  const pending = useRef(false);
  const failedIntent = useRef<LobbyRecommendationRequest | null>(null);

  useEffect(() => {
    if (!enabled) return;
    markLobbyVisit(scope);
    return () => markLobbyVisit(scope);
  }, [enabled, scope]);

  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      if (!visit) throw new Error('本次浏览未请求推荐');
      const { entry } = visit;
      // React/Next can re-subscribe while this route is leaving. Do not dispatch a successful
      // entry UUID twice; read the current authoritative value (possibly changed by a mutation).
      if (completedEntry.current === entry.request_id && lobbyViewerScope() === scope) {
        const current = client.getQueryData<LobbyRecommendationData>(key);
        if (current?.batch_id) return current;
      }
      const result = await requestRecommendation(
        recheck && cachedAtEntry
          ? {
              ...entry,
              action: 'resume',
              expected_batch_id: cachedAtEntry.batch_id,
            }
          : entry,
        signal
      );
      if (!signal.aborted && lobbyViewerScope() === scope) {
        if (recheck && cachedAtEntry && result.batch_id !== cachedAtEntry.batch_id) {
          const frame = checkedLobbyReadFrame(cachedAtEntry, result);
          lastReadFrames.set(scope, frame);
          setRechecked({ visit, frame });
        }
        rememberLobbyRecommendation(scope, result);
        completedEntry.current = entry.request_id;
      }
      return result;
    },
    initialData: () =>
      returningFrame ? (readLobbyRecommendation(scope) ?? cachedAtEntry) : cachedAtEntry,
    enabled,
    staleTime: reuseCached && !recheck ? Infinity : 0,
    gcTime: 30 * 24 * 60 * 60_000,
    refetchOnMount: reuseCached && !recheck ? false : 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const mutation = useMutation({
    mutationKey: [...key, 'change'],
    mutationFn: async (request: LobbyRecommendationRequest) => {
      await client.cancelQueries({ queryKey: key });
      let result;
      try {
        result = await requestRecommendation(request);
      } catch (error) {
        if (
          !(request.action === 'refresh' && error instanceof ApiClientError && error.status === 409)
        )
          throw error;
        result = await requestRecommendation({
          action: 'open',
          request_id: createLobbyRequestId(),
        });
      }
      if (result.enabled && result.head_cards === undefined) {
        return { ...result, ...(await readLegacyHeadCards(client, result.character_ids)) };
      }
      return result;
    },
    onSuccess: (result) => {
      if (lobbyViewerScope() !== scope) return;
      lastReadFrames.delete(scope);
      setRechecked(undefined);
      rememberLobbyRecommendation(scope, result);
      client.setQueryData(key, result);
      failedIntent.current = null;
    },
    retry: false,
  });

  const change = useCallback(
    async (action: 'refresh' | 'undo', restoreId?: string | null) => {
      if (pending.current || lobbyViewerScope() !== scope) return null;
      const current = client.getQueryData<LobbyRecommendationData>(key);
      if (action === 'undo' && !current?.batch_id) return null;
      const intent = action === 'refresh' && !current?.batch_id ? 'open' : action;
      const previous = failedIntent.current;
      const request: LobbyRecommendationRequest =
        previous?.action === intent && previous.expected_batch_id === (current?.batch_id ?? null)
          ? previous
          : {
              action: intent,
              request_id: createLobbyRequestId(),
              expected_batch_id: current?.batch_id ?? null,
              ...(action === 'undo' ? { restore_batch_id: restoreId } : {}),
            };
      failedIntent.current = request;
      pending.current = true;
      try {
        const result = await mutation.mutateAsync(request);
        return lobbyViewerScope() === scope ? result : null;
      } catch {
        return null;
      } finally {
        pending.current = false;
      }
    },
    [client, key, mutation, scope]
  );

  // An expired saved batch on a new browse is not painted then abruptly shuffled.
  // On failure, even that old batch is preferable to losing the user's list.
  const awaitingNewBatch =
    enabled &&
    !reuseCached &&
    !query.isFetchedAfterMount &&
    !query.isError &&
    (cachedAtEntry === undefined ||
      !hasHeadDetails(
        cachedAtEntry,
        client.getQueryData<GetCharactersData>(characterKeys.list('recommended'))
      ) ||
      (visit?.entry.action === 'open' &&
        cachedAtEntry.enabled &&
        Date.parse(cachedAtEntry.expires_at ?? '') <= Date.now()));

  const held = rechecked?.visit === visit ? (rechecked?.frame ?? returningFrame) : returningFrame;
  const frame =
    held && lastReadFrames.get(scope) === held && held.checkedAgainst === query.data?.batch_id
      ? held
      : undefined;
  return {
    data: frame?.batch ?? query.data,
    frame,
    settled: reuseCached || query.isFetchedAfterMount || query.isError,
    ready: !awaitingNewBatch,
    isFetching: query.isFetching,
    failed: query.isError,
    pending: mutation.isPending,
    changeFailed: mutation.isError,
    refresh: () => change('refresh'),
    undo: (restoreId: string) => change('undo', restoreId),
    scope,
  };
}

/** The first complete head wins this visit. A late personal batch is cached for the next visit. */
export function useLobbyDiscoveryFeed({
  sort,
  search,
  restore,
  manualChange,
  tailRequested,
}: {
  sort: LobbySort;
  search: boolean;
  restore: LobbyReturnSnapshot | null;
  manualChange: boolean;
  tailRequested: boolean;
}) {
  const recommended = sort === 'recommended' && !search;
  const restoringPublic =
    recommended &&
    !manualChange &&
    restore?.sort === 'recommended' &&
    !restore.query &&
    !restore.recommendationBatchId;
  const recommendation = useLobbyRecommendation({
    enabled: recommended && !restoringPublic,
    restoreBatchId: restore?.recommendationBatchId,
  });
  const deepReturn =
    recommended &&
    !manualChange &&
    restore?.sort === 'recommended' &&
    restore.loadedCharacterIds.indexOf(restore.anchorCharacterId) >= LOBBY_ROTATION_HEAD_SIZE;
  const usesDirectory = !recommended || tailRequested || deepReturn;
  const directory = useCharactersQuery(sort, usesDirectory);
  const batch =
    recommendation.ready && recommendation.data?.enabled ? recommendation.data : undefined;
  const privateHeadReady =
    !!batch &&
    (batch.head_cards !== undefined || (!!directory.data && hasHeadDetails(batch, directory.data)));
  const [hedge, setHedge] = useState(false);
  const [frozenPublic, setFrozenPublic] = useState<{
    data: GetCharactersData;
    checkedAt: number;
  }>();
  useEffect(() => {
    if (!recommended || privateHeadReady || frozenPublic) return;
    const timer = window.setTimeout(() => setHedge(true), 450);
    return () => window.clearTimeout(timer);
  }, [recommended, privateHeadReady, frozenPublic]);
  const needPublic =
    recommended &&
    !manualChange &&
    (restoringPublic || (!privateHeadReady && (hedge || recommendation.settled)));
  const restoredHead = restoringPublic ? restore?.publicHead : undefined;
  const restoreIds = useMemo(
    () =>
      restoringPublic ? restore?.loadedCharacterIds.slice(0, LOBBY_ROTATION_HEAD_SIZE) : undefined,
    [restoringPublic, restore]
  );
  const checkRestoredHead = useMemo(
    () =>
      !!restoringPublic && (!restoredHead || Date.now() - restoredHead.checkedAt >= 30 * 60_000),
    [restoringPublic, restoredHead]
  );
  // Recheck the original IDs, not today's top 12. An empty verified head alone means the
  // old anchor is no longer restorable; then fall forward to the current public head.
  const returnQuery = usePublicLobbyHead(
    needPublic && checkRestoredHead && !!restoreIds?.length,
    restoreIds ?? []
  );
  const returnedCards =
    restoringPublic && returnQuery.isFetchedAfterMount && !returnQuery.isError
      ? returnQuery.data
      : undefined;
  const replacedPublic = returnedCards?.characters.length === 0;
  const publicQuery = usePublicLobbyHead(
    needPublic && (replacedPublic || (!restoringPublic && !frozenPublic)),
    undefined,
    replacedPublic
  );
  const restoredSource = useMemo(
    () => (restoredHead ? { characters: restoredHead.cards } : undefined),
    [restoredHead]
  );
  const source = restoringPublic ? (restoredSource ?? returnQuery.data) : publicQuery.data;
  const publicView =
    recommended && !manualChange
      ? replacedPublic
        ? publicQuery.isFetchedAfterMount
          ? publicQuery.data
          : undefined
        : (returnedCards ?? frozenPublic?.data ?? (needPublic ? source : undefined))
      : undefined;
  const publicCheckedAt = replacedPublic
    ? publicQuery.dataUpdatedAt
    : returnedCards
      ? returnQuery.dataUpdatedAt
      : (frozenPublic?.checkedAt ?? restoredHead?.checkedAt ?? publicQuery.dataUpdatedAt);
  useLayoutEffect(() => {
    if (
      publicView &&
      (publicView !== frozenPublic?.data || publicCheckedAt !== frozenPublic.checkedAt)
    )
      setFrozenPublic({ data: publicView, checkedAt: publicCheckedAt });
  }, [publicView, publicCheckedAt, frozenPublic]);

  const data = useMemo(() => {
    if (!recommended) return directory.data;
    // When an authoritative full list is actually requested, it governs delisting; an older
    // full-list cache must not suppress new head cards before that reconciliation.
    const full = usesDirectory ? directory.data?.characters : undefined;
    if (publicView) {
      const headIds =
        restoringPublic && !replacedPublic
          ? restore!.loadedCharacterIds
          : publicView.characters.map((c) => c.id);
      const available = full ?? publicView.characters;
      const order = full ? [...headIds, ...full.map((c) => c.id)] : headIds;
      return { characters: projectLobbyOrder(available, order) };
    }
    if (!batch || !privateHeadReady || restoringPublic) return undefined;
    const available =
      full ?? recommendation.frame?.cards ?? batch.head_cards ?? directory.data?.characters ?? [];
    return {
      characters: projectLobbyOrder(available, recommendation.frame?.order ?? batch.character_ids),
    };
  }, [
    recommended,
    directory.data,
    usesDirectory,
    publicView,
    restoringPublic,
    replacedPublic,
    restore,
    batch,
    privateHeadReady,
    recommendation.frame,
  ]);

  const resetVisit = () => {
    setFrozenPublic(undefined);
    setHedge(false);
  };
  const isError =
    !data &&
    ((usesDirectory && directory.isError) ||
      (recommended &&
        (publicQuery.isError || returnQuery.isError) &&
        (restoringPublic || recommendation.settled)));
  return {
    recommendation,
    resetVisit,
    data,
    usesDirectory,
    publicView,
    publicCheckedAt,
    hasUnloadedTail:
      recommended &&
      !usesDirectory &&
      (publicView
        ? publicView.characters.length >= LOBBY_ROTATION_HEAD_SIZE ||
          (restoringPublic &&
            !replacedPublic &&
            (restoredHead?.hasTail === true ||
              (restore?.loadedCharacterIds.length ?? 0) >= LOBBY_ROTATION_HEAD_SIZE))
        : !!batch && batch.character_ids.length > (data?.characters.length ?? 0)),
    tailFailed: recommended && usesDirectory && directory.isError && !!data,
    isError,
    isLoading: (!data || (deepReturn && !directory.data && !directory.isError)) && !isError,
    isFetching: usesDirectory ? directory.isFetching : !publicView && recommendation.isFetching,
    isFetchedAfterMount: directory.isFetchedAfterMount,
    refetch: directory.refetch,
  };
}

export function useLobbyExposureMutation() {
  return useMutation({
    mutationFn: async ({ scope, ...body }: LobbyRecommendationExposures & { scope: string }) => {
      if (lobbyViewerScope() !== scope) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        await apiClient<LobbyRecommendationExposuresData>(
          '/api/characters/recommendation/exposures',
          {
            method: 'POST',
            body: JSON.stringify(body),
            signal: controller.signal,
            timeoutMs: 4000,
            queuePriority: 'background',
            keepalive: true,
          }
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    retry: 1,
    retryDelay: 800,
  });
}
