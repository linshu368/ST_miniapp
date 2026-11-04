'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LobbyRecommendationDataSchema,
  type GetCharactersData,
  type LobbyRecommendationData,
  type LobbyRecommendationExposures,
  type LobbyRecommendationExposuresData,
  type LobbyRecommendationRequest,
} from '@miniapp/shared';
import {
  createLobbyRequestId,
  lobbyEntryRequest,
  lobbyViewerScope,
  markLobbyVisit,
  readLobbyRecommendation,
  rememberLobbyRecommendation,
} from '@/lib/lobby-recommendation-state';
import { apiClient, ApiClientError } from './client';
import { characterKeys } from './characters';

export const lobbyRecommendationKeys = {
  viewer: (scope: string) => ['lobby-recommendation', scope] as const,
};

const ENTRY_RECOMMENDATION_TIMEOUT_MS = 1_500;
const MANUAL_RECOMMENDATION_TIMEOUT_MS = 5_000;

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function hasHeadDetails(batch: LobbyRecommendationData, catalogue: GetCharactersData | undefined) {
  if (!batch.enabled || batch.head_ids.length === 0) return true;
  const available = new Set(catalogue?.characters.map((character) => character.id));
  return batch.head_ids.every((id) => available.has(id));
}

async function requestRecommendation(
  body: LobbyRecommendationRequest,
  signal?: AbortSignal,
  timeoutMs = MANUAL_RECOMMENDATION_TIMEOUT_MS
): Promise<LobbyRecommendationData> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  // Includes queueing and body decoding, not only receipt of response headers.
  const timeout = setTimeout(() => controller.abort(new Error('推荐读取超时')), timeoutMs);
  try {
    const data = await apiClient<unknown>('/api/characters/recommendation', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
      timeoutMs,
      queuePriority: 'critical',
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
  const entry = useMemo(() => lobbyEntryRequest(scope, restoreBatchId), [scope, restoreBatchId]);
  const key = useMemo(() => lobbyRecommendationKeys.viewer(scope), [scope]);
  const cachedAtEntry = useMemo(() => readLobbyRecommendation(scope), [scope]);
  const pending = useRef(false);
  const failedIntent = useRef<LobbyRecommendationRequest | null>(null);

  const prepareBatch = useCallback(
    async (result: LobbyRecommendationData, signal?: AbortSignal) => {
      if (!result.enabled) return result;
      const catalogueKey = characterKeys.list('recommended');
      let catalogue = client.getQueryData<GetCharactersData>(catalogueKey);
      if (!hasHeadDetails(result, catalogue)) {
        // A fresh private batch can arrive before the shared catalogue's background
        // reconciliation. Resolve missing covers first, while the old batch stays put.
        await client.refetchQueries(
          { queryKey: catalogueKey, exact: true },
          { throwOnError: true, cancelRefetch: false }
        );
        catalogue = client.getQueryData<GetCharactersData>(catalogueKey);
      }
      if (signal?.aborted) throw signal.reason;
      if (!catalogue) throw new Error('角色资料暂未准备好');
      const available = new Set(catalogue.characters.map((character) => character.id));
      // Still absent after a successful refresh means delisted/unavailable. Keep that
      // decision for this batch so another public refresh cannot insert cards mid-read.
      return {
        ...result,
        character_ids: result.character_ids.filter((id) => available.has(id)),
        head_ids: result.head_ids.filter((id) => available.has(id)),
      };
    },
    [client]
  );

  useEffect(() => {
    markLobbyVisit(scope);
    return () => markLobbyVisit(scope);
  }, [scope]);

  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const deadline = new AbortController();
      const onAbort = () => deadline.abort(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(
        () => deadline.abort(new Error('推荐入场准备超时')),
        ENTRY_RECOMMENDATION_TIMEOUT_MS
      );
      try {
        // 目录缺资料时 prepareBatch 会触发共享目录校准；校准可以在后台继续，
        // 但当前页面必须在统一入场预算内降级，不能再次被慢目录拖住。
        const result = await awaitWithSignal(
          prepareBatch(
            await requestRecommendation(entry, deadline.signal, ENTRY_RECOMMENDATION_TIMEOUT_MS),
            deadline.signal
          ),
          deadline.signal
        );
        if (!deadline.signal.aborted && lobbyViewerScope() === scope)
          rememberLobbyRecommendation(scope, result);
        return result;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      }
    },
    initialData: () => cachedAtEntry,
    enabled,
    staleTime: Infinity,
    gcTime: 30 * 24 * 60 * 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const mutation = useMutation({
    mutationKey: [...key, 'change'],
    mutationFn: async (request: LobbyRecommendationRequest) => {
      await client.cancelQueries({ queryKey: key });
      try {
        return await prepareBatch(await requestRecommendation(request));
      } catch (error) {
        // Another window may have moved on. Refresh resolves the authoritative batch once;
        // undo must fail rather than silently claim it restored a no-longer-current pair.
        if (request.action === 'refresh' && error instanceof ApiClientError && error.status === 409)
          return prepareBatch(
            await requestRecommendation({ action: 'open', request_id: createLobbyRequestId() })
          );
        throw error;
      }
    },
    onSuccess: (result) => {
      if (lobbyViewerScope() !== scope) return;
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
      if (!current?.enabled || !current.batch_id) return null;
      const previous = failedIntent.current;
      const request: LobbyRecommendationRequest =
        previous?.action === action && previous.expected_batch_id === current.batch_id
          ? previous
          : {
              action,
              request_id: createLobbyRequestId(),
              expected_batch_id: current.batch_id,
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
    !query.isFetchedAfterMount &&
    !query.isError &&
    (cachedAtEntry === undefined ||
      !hasHeadDetails(
        cachedAtEntry,
        client.getQueryData<GetCharactersData>(characterKeys.list('recommended'))
      ) ||
      (entry.action === 'open' &&
        cachedAtEntry.enabled &&
        Date.parse(cachedAtEntry.expires_at ?? '') <= Date.now()));

  return {
    data: query.data,
    settled: query.isFetchedAfterMount || query.isError,
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
