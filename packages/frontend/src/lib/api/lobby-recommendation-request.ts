'use client';

import {
  LobbyRecommendationDataSchema,
  type LobbyRecommendationData,
  type LobbyRecommendationRequest,
} from '@miniapp/shared';
import { apiClient, ApiClientError } from './client';

export const ENTRY_RECOMMENDATION_TIMEOUT_MS = 1_500;
const MANUAL_RECOMMENDATION_TIMEOUT_MS = 5_000;

export async function requestRecommendation(
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
    const fetch = (payload: LobbyRecommendationRequest) =>
      apiClient<unknown>('/api/characters/recommendation', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
        timeoutMs,
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
