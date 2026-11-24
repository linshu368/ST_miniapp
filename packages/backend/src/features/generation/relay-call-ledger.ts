import { createHash } from 'node:crypto';
import type { RelayProvider } from '@miniapp/shared';
import { prisma } from '../../lib/db.js';
import { config } from '../../platform/config.js';
import { getRelayManagementConfig } from '../../platform/runtime-config.js';
import { relayUsageSnapshot } from './relay-usage.js';

/** Stable across Key rotation so one account invoice cannot be claimed twice under two Keys. */
export function relayAccountRef(provider: RelayProvider): string {
  let management = '';
  try {
    const settings = getRelayManagementConfig(provider);
    management = `${settings.baseUrl}:${settings.userId}`;
  } catch {
    /* Inference does not depend on management config. */
  }
  return `${provider}:${config.database.target}:${createHash('sha256').update(management).digest('hex').slice(0, 32)}`;
}

export interface RelayCallObservation {
  id: string;
  attemptId: string | null;
  historyId: string;
  provider: RelayProvider;
  model: string;
  lane: 'chat' | 'free_zone';
  candidateId: string | null;
  dispatchedAt: Date;
  requestId: string | null;
  generationId: string | null;
  httpStatus: number | null;
  finishReason: string | null;
  status: 'unknown' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  usage: unknown;
  durationMs: number | null;
}

export async function writeRelayCall(call: RelayCallObservation): Promise<void> {
  const snapshot = relayUsageSnapshot(call.usage);
  const usage = snapshot.usage;
  const endReason =
    call.attemptId || call.status === 'unknown'
      ? null
      : call.status === 'succeeded'
        ? 'completed'
        : call.status === 'failed'
          ? 'upstream_error'
          : call.status === 'cancelled'
            ? 'cancelled'
            : 'stream_interrupted';
  await prisma.$executeRaw`
    INSERT INTO ops.llm_calls AS l (id, attempt_id, chat_history_id, provider, model, provider_account_ref,
      lane, role, slot, candidate_id, dispatched_at, request_id, generation_id, http_status, call_status,
      finish_reason, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, generation_time_ms, raw_usage, end_reason)
    VALUES (${call.id}::uuid, ${call.attemptId}::uuid, ${call.historyId}::uuid, ${call.provider}, ${call.model}, ${relayAccountRef(call.provider)},
      ${call.lane}, 'primary', 0, ${call.candidateId}, ${call.dispatchedAt}, ${call.requestId}, ${call.generationId}, ${call.httpStatus}::int,
      ${call.status}, ${call.finishReason}, ${usage.prompt_tokens}::bigint, ${usage.completion_tokens}::bigint,
      ${usage.cached_tokens}::bigint, ${usage.reasoning_tokens}::bigint, ${call.durationMs}::numeric, ${JSON.stringify(snapshot)}::jsonb, ${endReason})
    ON CONFLICT (id) DO UPDATE SET
      provider_account_ref = COALESCE(l.provider_account_ref, EXCLUDED.provider_account_ref),
      request_id = COALESCE(l.request_id, EXCLUDED.request_id), generation_id = COALESCE(l.generation_id, EXCLUDED.generation_id),
      http_status = COALESCE(l.http_status, EXCLUDED.http_status),
      call_status = CASE WHEN l.call_status IS NULL OR l.call_status = 'unknown' THEN EXCLUDED.call_status ELSE l.call_status END,
      finish_reason = COALESCE(l.finish_reason, EXCLUDED.finish_reason),
      end_reason = COALESCE(l.end_reason, EXCLUDED.end_reason),
      prompt_tokens = COALESCE(l.prompt_tokens, EXCLUDED.prompt_tokens), completion_tokens = COALESCE(l.completion_tokens, EXCLUDED.completion_tokens),
      cached_tokens = COALESCE(l.cached_tokens, EXCLUDED.cached_tokens), reasoning_tokens = COALESCE(l.reasoning_tokens, EXCLUDED.reasoning_tokens),
      generation_time_ms = COALESCE(l.generation_time_ms, EXCLUDED.generation_time_ms),
      raw_usage = CASE WHEN l.cost_source IS NULL THEN EXCLUDED.raw_usage ELSE l.raw_usage END, updated_at = now()
    WHERE l.provider = EXCLUDED.provider AND l.chat_history_id = EXCLUDED.chat_history_id AND l.model IS NOT DISTINCT FROM EXCLUDED.model`;
  if (call.status !== 'unknown')
    await prisma.$executeRaw`
    INSERT INTO ops.llm_cost_jobs (call_id, kind, status, attempts, next_retry_at)
    SELECT id, 'call_cost', 'pending', 0, now() + interval '60 seconds' FROM ops.llm_calls
    WHERE id = ${call.id}::uuid AND provider = ${call.provider} AND cost_source IS NULL
    ON CONFLICT (call_id) DO NOTHING`;
}
