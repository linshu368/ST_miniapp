import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import type { ChatHistorySyncRow } from './ConversationHistoryRepository.js';

/**
 * Provider-reported metadata for one upstream call, in the provider-neutral field names the
 * `experience.record_llm_call_metadata` RPC expects. OpenRouter reports `usage` in USD; Venice's
 * `usage` is micro-USD (its catalogue prices are per million tokens) and the RPC converts it.
 */
export interface LlmCallMetadata {
  provider_name?: string | null;
  finish_reason?: string | null;
  usage?: number | null;
  usage_cache?: number | null;
  native_tokens_cached?: number | null;
  native_tokens_reasoning?: number | null;
  native_tokens_completion?: number | null;
  native_tokens_prompt?: number | null;
  latency?: number | null;
  generation_time?: number | null;
  model?: string | null;
  llm_generation_data?: unknown;
}

type GapRow = Omit<ChatHistorySyncRow, 'generationId' | 'callProvider'> & {
  delivery_provider: string | null;
  generation_id: string | null;
};

const READ_BATCH_SIZE = 50;

/**
 * Upstream call observations live in `ops.llm_calls` (db reorg 6a-2c), one row per
 * chat_generation_attempts id. They never decide who delivered or how much is charged; the sync job
 * only uses them to judge whether OpenRouter's asynchronous statistics have arrived.
 */
export class LlmCallRepository {
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {}

  /** Fills only empty values; `generationId` null means the turn's delivered call. */
  async recordMetadata(
    historyId: string,
    generationId: string | null,
    metadata: LlmCallMetadata
  ): Promise<void> {
    const { error } = await this.db
      .rpc('record_llm_call_metadata', {
        p_history_id: historyId,
        p_generation_id: generationId,
        p_metadata: metadata,
      })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`回写上游调用元数据失败：${error.message}`, { cause: error });
  }

  /** Delivered OpenRouter call metadata keyed by turn id, under the field names sync recovery checks. */
  async readOpenRouterMetadataBatch(
    historyIds: string[]
  ): Promise<Map<string, Record<string, unknown>>> {
    const ids = [...new Set(historyIds.filter((id) => id.length > 0))];
    const result = new Map<string, Record<string, unknown>>();
    for (let offset = 0; offset < ids.length; offset += READ_BATCH_SIZE) {
      const { data, error } = await this.db
        .rpc('read_llm_call_metadata', {
          p_history_ids: ids.slice(offset, offset + READ_BATCH_SIZE),
        })
        .abortSignal(AbortSignal.timeout(5_000));
      if (error) throw new Error('批量读取 OpenRouter 已存调用事实失败', { cause: error });
      for (const value of (data ?? []) as Array<Record<string, unknown>>) {
        const { chat_history_id: historyId, ...metadata } = value;
        if (typeof historyId === 'string') result.set(historyId, metadata);
      }
    }
    return result;
  }

  /** Finished turns whose delivered OpenRouter call still lacks complete statistics, newest first. */
  async listMetadataGaps(input: { since: string; limit: number }): Promise<ChatHistorySyncRow[]> {
    const { data, error } = await this.db
      .rpc('list_llm_call_metadata_gaps', { p_since: input.since, p_limit: input.limit })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('扫描待补齐的 OpenRouter 调用元数据失败', { cause: error });
    return ((data ?? []) as GapRow[]).flatMap(
      ({ delivery_provider: _provider, generation_id: generationId, ...row }) => {
        if (!generationId) return [];
        const snapshotProvider = row.llm_billing_snapshot?.provider;
        const conflict = !!snapshotProvider && snapshotProvider !== 'openrouter';
        return [{ ...row, generationId, callProvider: conflict ? null : ('openrouter' as const) }];
      }
    );
  }
}
