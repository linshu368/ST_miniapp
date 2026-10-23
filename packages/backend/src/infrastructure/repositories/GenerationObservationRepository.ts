import type { LlmModelProvider, ReportFirstTokenRequest } from '@miniapp/shared';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import type { LlmBillingSnapshot } from './ConversationHistoryRepository.js';

export type AttemptRole = 'primary' | 'fallback';
export interface AttemptObservation {
  id: string;
  role: AttemptRole;
  provider: LlmModelProvider;
  model: string;
  generation_id?: string | null;
  dispatched_at?: string;
  dispatch_offset_ms?: number;
  headers_ms?: number;
  first_chunk_ms?: number;
  first_token_ms?: number;
  observed_until_ms?: number;
  http_status?: number;
  end_reason?:
    | 'first_token_observed'
    | 'first_token_deadline'
    | 'completed'
    | 'upstream_error'
    | 'cancelled'
    | 'observation_deadline'
    | 'stream_interrupted';
  provider_latency_ms?: number;
  provider_name?: string;
  provider_reported_model?: string;
  finish_reason?: string;
}

/** Raw generation facts live beside their revision; analytics never owns runtime state. */
export class GenerationObservationRepository {
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {}

  async begin(input: {
    historyId: string;
    requestId: string;
    primaryAttemptId: string;
    requestedModelId: string;
    provider: LlmModelProvider;
    model: string;
    receivedAt: string;
    fallbackModelId?: string;
    timeoutMs: number;
    deadlineMs: number;
    timeoutRateTarget: number;
    catalogVersion: number;
    mode: 'send' | 'regenerate';
    snapshot?: LlmBillingSnapshot;
  }): Promise<void> {
    const { error } = await this.db
      .rpc('begin_chat_generation_observation', {
        p_history_id: input.historyId,
        p_input: {
          request_id: input.requestId,
          primary_attempt_id: input.primaryAttemptId,
          requested_model_id: input.requestedModelId,
          provider: input.provider,
          model: input.model,
          received_at: input.receivedAt,
          fallback_model_id: input.fallbackModelId,
          timeout_ms: input.timeoutMs,
          deadline_ms: input.deadlineMs,
          timeout_rate_target: input.timeoutRateTarget,
          catalog_version: input.catalogVersion,
          mode: input.mode,
          snapshot: input.snapshot,
        },
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('保存生成请求与首发意图失败', { cause: error });
  }

  async prepareFallback(
    historyId: string,
    attempt: AttemptObservation,
    triggeredMs: number
  ): Promise<void> {
    const { error } = await this.db
      .rpc('prepare_chat_generation_fallback', {
        p_history_id: historyId,
        p_attempt_id: attempt.id,
        p_triggered_ms: triggeredMs,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('保存兜底调用意图失败', { cause: error });
  }

  async observe(historyId: string, attempt: AttemptObservation): Promise<void> {
    const { error } = await this.db
      .rpc('observe_chat_generation_attempt', {
        p_history_id: historyId,
        p_observation: attempt,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('保存模型调用观测失败', { cause: error });
  }

  async selectDelivery(historyId: string, attempt: AttemptObservation): Promise<void> {
    const { error } = await this.db
      .rpc('select_chat_generation_delivery', {
        p_history_id: historyId,
        p_attempt_id: attempt.id,
        p_generation_id: attempt.generation_id ?? null,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('确认生成交付身份失败', { cause: error });
  }

  async markServer(
    historyId: string,
    patch: {
      first_token_emitted_ms?: number;
      first_token_timeout?: boolean;
      billing_rejected?: boolean;
    }
  ): Promise<void> {
    const { error } = await this.db
      .from('chat_generation_requests')
      .update(patch)
      .eq('chat_history_id', historyId)
      .abortSignal(AbortSignal.timeout(3_000));
    if (error) throw new Error('保存业务首 token 阶段失败', { cause: error });
  }

  async enrichGeneration(
    generationId: string,
    metadata: {
      latency: number | null;
      provider_name: string | null;
      finish_reason: string | null;
      model?: string | null;
    }
  ): Promise<void> {
    const patch = {
      ...(metadata.latency !== null ? { provider_latency_ms: metadata.latency } : {}),
      ...(metadata.provider_name ? { provider_name: metadata.provider_name } : {}),
      ...(metadata.model ? { provider_reported_model: metadata.model } : {}),
      ...(metadata.finish_reason ? { finish_reason: metadata.finish_reason } : {}),
    };
    if (!Object.keys(patch).length) return;
    const { error } = await this.db
      .from('chat_generation_attempts')
      .update(patch)
      .eq('provider', 'openrouter')
      .eq('generation_id', generationId)
      .abortSignal(AbortSignal.timeout(3000));
    if (error) throw new Error('补充供应商首 token 观测失败', { cause: error });
  }

  async report(
    userId: string,
    sessionId: string,
    input: ReportFirstTokenRequest
  ): Promise<boolean> {
    const { data, error } = await this.db
      .rpc('report_chat_first_token', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_report: input,
      })
      .abortSignal(AbortSignal.timeout(3_000));
    if (error) throw new Error('保存用户首 token 显示观测失败', { cause: error });
    return data === true;
  }
}
