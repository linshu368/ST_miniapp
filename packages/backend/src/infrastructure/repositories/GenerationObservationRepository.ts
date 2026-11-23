import type { LlmModelProvider, ReportFirstTokenRequest } from '@miniapp/shared';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import { withStoredRequestId, type LlmBillingSnapshot } from './ConversationHistoryRepository.js';
import type { GenerationMessage } from '../../features/generation/types.js';
import { walletBalanceReason, WalletInsufficientBalanceError } from './wallet-errors.js';

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
    | 'budget_skipped'
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
  /** Only already-received loser fragments; never user delivery or billing metadata. */
  discarded_response?: {
    reason: 'race_lost';
    content: string;
    reasoning: string;
    truncated: boolean;
  };
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
    fallbackTimeoutMs?: number;
    deadlineMs: number;
    timeoutRateTarget: number;
    catalogVersion: number;
    mode: 'send' | 'regenerate';
    snapshot?: LlmBillingSnapshot;
    /** Atomically persists admission identity or the final immutable prompt with its quote. */
    chargeId?: string;
    history?: GenerationMessage[];
    recoverableDelivery?: boolean;
    measurementMethod?: 'client_committed_v4';
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
          fallback_timeout_ms: input.fallbackTimeoutMs,
          deadline_ms: input.deadlineMs,
          timeout_rate_target: input.timeoutRateTarget,
          catalog_version: input.catalogVersion,
          mode: input.mode,
          snapshot: input.snapshot,
          charge_id: input.chargeId,
          history:
            input.history === undefined
              ? undefined
              : withStoredRequestId(input.history, input.requestId),
          recoverable_delivery: input.recoverableDelivery ?? false,
          measurement_method: input.measurementMethod,
        },
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) {
      const reason = walletBalanceReason(error);
      if (reason) throw new WalletInsufficientBalanceError(reason, error);
      throw new Error('保存生成请求与首发意图失败', { cause: error });
    }
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
    // The RPC stores only call identity, the three timings the free-zone evaluation reads, and the
    // terminal snapshot. Headers/first-chunk/provider latency go to OTel (observeGenerationAttempt).
    const stored = {
      id: attempt.id,
      role: attempt.role,
      provider: attempt.provider,
      model: attempt.model,
      generation_id: attempt.generation_id,
      dispatched_at: attempt.dispatched_at,
      dispatch_offset_ms: attempt.dispatch_offset_ms,
      first_token_ms: attempt.first_token_ms,
      observed_until_ms: attempt.observed_until_ms,
      end_reason: attempt.end_reason,
      finish_reason: attempt.finish_reason,
      discarded_response: attempt.discarded_response,
    };
    const { error } = await this.db
      .rpc('observe_chat_generation_attempt', {
        p_history_id: historyId,
        p_observation: stored,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('保存模型调用观测失败', { cause: error });
  }

  /**
   * 开发与产品排查用的 prompt 快照（ops.chat_prompt_snapshots，保留 7 天，非业务数据）。
   * 调用方在开轮放行后异步调用、不 await；同一轮重放时覆盖。
   */
  async savePromptSnapshot(historyId: string, messages: GenerationMessage[]): Promise<void> {
    const { error } = await this.db
      .rpc('record_chat_prompt_snapshot', { p_history_id: historyId, p_messages: messages })
      .abortSignal(AbortSignal.timeout(10_000));
    if (error) throw new Error('保存 prompt 快照失败', { cause: error });
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

  async checkpoint(
    historyId: string,
    revision: number,
    readyMs: number,
    kind: 'delta' | 'reasoning',
    text: string
  ): Promise<void> {
    const { error } = await this.db
      .rpc('record_chat_delivery_preview', {
        p_history_id: historyId,
        p_revision: revision,
        p_ready_ms: readyMs,
        p_kind: kind,
        p_text: text.trimStart().slice(0, 2048),
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('保存可恢复首字失败', { cause: error });
  }

  async markServer(
    historyId: string,
    patch: {
      first_token_timeout?: boolean;
      server_timeout_stage?: 'global' | 'primary' | 'fallback';
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

  /** Provider-reported finish reason for the delivered OpenRouter call; latency/provider/model stay in its metadata row. */
  async enrichGeneration(
    generationId: string,
    metadata: { finish_reason: string | null }
  ): Promise<void> {
    if (!metadata.finish_reason) return;
    const { error } = await this.db
      .from('chat_generation_attempts')
      .update({ finish_reason: metadata.finish_reason })
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
    // These diagnostic durations now belong to Grafana. Keep reception/delivery
    // fields because legacy billing compatibility still depends on them.
    const { request_dispatched_ms: _dispatch, wait_finished_ms: _finished, ...receipt } = input;
    const { data, error } = await this.db
      .rpc('report_chat_first_token', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_report: receipt,
      })
      .abortSignal(AbortSignal.timeout(3_000));
    if (error) throw new Error('保存用户首 token 显示观测失败', { cause: error });
    return data === true;
  }
}
