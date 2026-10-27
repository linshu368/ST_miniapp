'use client';

import { useQuery } from '@tanstack/react-query';
import {
  parseGetReplayContextData,
  DRAMA_TIMING_BODY_LIMIT,
  DRAMA_TIMING_UPLOAD_TIMEOUT_MS,
  DramaTimingReportSchema,
  PostDramaTimingDataSchema,
  type DramaTimingReport,
  type PostDramaTimingData,
  type GetReplayContextData,
} from '@miniapp/shared';

import { apiClient } from './client';

export const REPLAY_CONTEXT_TIMEOUT_MS = 4_000;

/** 单次、低优先级上报；总预算包括排队和响应体，不能拖住播放或无限积压。 */
export async function uploadDramaTiming(report: DramaTimingReport): Promise<void> {
  const body = JSON.stringify(DramaTimingReportSchema.parse(report));
  if (new TextEncoder().encode(body).byteLength > DRAMA_TIMING_BODY_LIMIT) {
    throw new Error('drama_timing_report_too_large');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAMA_TIMING_UPLOAD_TIMEOUT_MS);
  try {
    const data = await apiClient<PostDramaTimingData>('/api/telemetry/drama-timing', {
      method: 'POST',
      body,
      signal: controller.signal,
      timeoutMs: DRAMA_TIMING_UPLOAD_TIMEOUT_MS,
      queuePriority: 'background',
      keepalive: true,
    });
    PostDramaTimingDataSchema.parse(data);
  } finally {
    clearTimeout(timer);
  }
}

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
