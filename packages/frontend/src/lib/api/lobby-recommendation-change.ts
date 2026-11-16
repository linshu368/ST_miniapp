'use client';

import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LobbyRecommendationData, LobbyRecommendationRequest } from '@miniapp/shared';
import {
  createLobbyRequestId,
  lobbyViewerScope,
  rememberLobbyRecommendation,
} from '@/lib/lobby-recommendation-state';
import { ApiClientError } from './client';
import { readLegacyHeadCards } from './characters';
import { requestRecommendation } from './lobby-recommendation-request';

/** Manual intents retain their 5s budget and UUID even when refresh falls back to open. */
export function useLobbyRecommendationChange(
  scope: string,
  key: readonly string[],
  onAccepted: () => void
) {
  const client = useQueryClient();
  const pending = useRef(false);
  const failedIntent = useRef<LobbyRecommendationRequest | null>(null);
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
      onAccepted();
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

  return {
    pending: mutation.isPending,
    changeFailed: mutation.isError,
    refresh: () => change('refresh'),
    undo: (id: string) => change('undo', id),
  };
}
