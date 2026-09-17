'use client';

import { useQuery } from '@tanstack/react-query';
import { parseGetReplayContextData, type GetReplayContextData } from '@miniapp/shared';

import { apiClient } from './client';

export const REPLAY_CONTEXT_TIMEOUT_MS = 4_000;

export const replayContextKeys = {
  all: ['telemetry', 'replay-context'] as const,
};

function mergeAbortSignals(primary: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!primary) return timeout;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([primary, timeout]);
  }
  return timeout;
}

export async function fetchReplayContext(signal?: AbortSignal): Promise<GetReplayContextData> {
  const data = await apiClient<unknown>('/api/telemetry/replay-context', {
    signal: mergeAbortSignals(signal, REPLAY_CONTEXT_TIMEOUT_MS),
  });
  return parseGetReplayContextData(data);
}

export function useReplayContextQuery(enabled: boolean) {
  return useQuery({
    queryKey: replayContextKeys.all,
    queryFn: ({ signal }) => fetchReplayContext(signal),
    enabled,
    staleTime: 60_000,
    retry: 1,
    retryDelay: 400,
  });
}
