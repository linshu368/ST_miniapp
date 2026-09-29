import { getDomainDb } from '../../lib/supabase.js';

export interface VeniceChatHistoryMetadata {
  chat_history_id: string;
  llm_provider_name: 'venice';
  llm_finish_reason: string | null;
  /** Same semantics as chat_history.llm_usage: total upstream USD cost, encoded as JSON number. */
  llm_usage: number | null;
  /** Estimated cached-input USD cost, encoded as JSON number. */
  llm_usage_cache: number | null;
  llm_native_tokens_cached: number | null;
  llm_native_tokens_reasoning: number | null;
  llm_native_tokens_completion: number | null;
  llm_native_tokens_prompt: number | null;
  llm_latency: number | null;
  llm_generation_time: number | null;
  llm_model: string;
  llm_generation_id: string | null;
  llm_generation_data: Record<string, unknown>;
}

/** Writes only bounded provider metadata; conversation content stays in chat_history. */
export class VeniceChatHistoryRepository {
  private readonly db = getDomainDb('experience');

  async upsert(metadata: VeniceChatHistoryMetadata): Promise<void> {
    const { error } = await this.db.from('venice_chat_history').upsert(
      {
        ...metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'chat_history_id' }
    );
    if (error) throw new Error(`回写 Venice 调用明细失败：${error.message}`);
  }
}
