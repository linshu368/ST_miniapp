import { getDomainDb, type DomainDb } from '../../lib/supabase.js';

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
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {}

  async ensurePlaceholder(chatHistoryId: string): Promise<void> {
    const { error } = await this.db
      .from('venice_chat_history')
      .upsert(
        { chat_history_id: chatHistoryId },
        { onConflict: 'chat_history_id', ignoreDuplicates: true }
      )
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('保存 Venice 调用占位失败', { cause: error });
  }

  async ensureGenerationId(chatHistoryId: string, generationId: string): Promise<void> {
    if (!generationId.trim()) throw new Error('调用 ID 为空');
    const deadline = AbortSignal.timeout(10_000);
    await this.ensurePlaceholder(chatHistoryId);
    // Only fill an empty identity. A late replica can never replace an existing call.
    for (let attempt = 0; attempt < 2; attempt++) {
      deadline.throwIfAborted();
      const write = await this.db
        .from('venice_chat_history')
        .update({ llm_generation_id: generationId, updated_at: new Date().toISOString() })
        .eq('chat_history_id', chatHistoryId)
        .is('llm_generation_id', null)
        .select('llm_generation_id')
        .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(5_000)]))
        .maybeSingle();
      if (!write.error && write.data) return;
      // A timed out write may have committed: read back before retrying the same identity.
      const read = await this.db
        .from('venice_chat_history')
        .select('llm_generation_id')
        .eq('chat_history_id', chatHistoryId)
        .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(5_000)]))
        .maybeSingle();
      if (!read.error && read.data?.llm_generation_id === generationId) return;
      if (!read.error && read.data?.llm_generation_id) throw new Error('Venice 调用 ID 冲突');
      if (attempt === 1)
        throw new Error('保存 Venice 调用 ID 未确认', { cause: write.error ?? read.error });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async upsert(metadata: VeniceChatHistoryMetadata): Promise<void> {
    const { llm_generation_id: generationId, ...fields } = metadata;
    if (generationId) await this.ensureGenerationId(metadata.chat_history_id, generationId);
    else await this.ensurePlaceholder(metadata.chat_history_id);
    const { error } = await this.db
      .from('venice_chat_history')
      .upsert(
        {
          ...fields,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'chat_history_id' }
      )
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`回写 Venice 调用明细失败：${error.message}`);
  }
}
