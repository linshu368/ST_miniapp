import type { ChatHistorySyncRow, LlmBillingSnapshot } from './ConversationHistoryRepository.js';
import { getDomainDb } from '../../lib/supabase.js';

export type OpenRouterChatHistoryMetadata = Record<string, unknown> & {
  chat_history_id: string;
  llm_provider_name: 'openrouter';
  llm_generation_id?: string | null;
};

interface OpenRouterCandidateRow {
  chat_history_id: string;
  llm_generation_id: string | null;
}

/** Stores only OpenRouter call metadata; parent chat_history remains the business and billing record. */
export class OpenRouterChatHistoryRepository {
  private readonly db = getDomainDb('experience');

  async ensureGenerationId(chatHistoryId: string, generationId: string): Promise<void> {
    const { error } = await this.db.from('openrouter_chat_history').upsert(
      {
        chat_history_id: chatHistoryId,
        llm_provider_name: 'openrouter',
        llm_generation_id: generationId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'chat_history_id' }
    );
    if (error) throw new Error(`保存 OpenRouter generation ID 失败：${error.message}`);
  }

  async upsert(metadata: OpenRouterChatHistoryMetadata): Promise<void> {
    const { error } = await this.db.from('openrouter_chat_history').upsert(
      {
        ...metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'chat_history_id' }
    );
    if (error) throw new Error(`回写 OpenRouter 调用明细失败：${error.message}`);
  }

  /**
   * The metadata table owns the OpenRouter generation ID. Parent rows supply
   * billing facts only after the bounded candidate query has located them.
   */
  async listRowsMissingGenerationData(input: {
    since: string;
    limit: number;
  }): Promise<ChatHistorySyncRow[]> {
    const { data: candidates, error: candidateError } = await this.db
      .from('openrouter_chat_history')
      .select('chat_history_id,llm_generation_id')
      .not('llm_generation_id', 'is', null)
      .gte('created_at', input.since)
      .or(
        'llm_generation_data.is.null,llm_usage.is.null,llm_latency.is.null,llm_generation_time.is.null,llm_finish_reason.is.null'
      )
      .order('created_at', { ascending: false })
      .limit(input.limit);
    if (candidateError)
      throw new Error(`扫描待补齐的 OpenRouter 调用明细失败：${candidateError.message}`);

    const ids = (candidates ?? [])
      .map((row) => (row as OpenRouterCandidateRow).chat_history_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return [];

    const { data: histories, error: historyError } = await this.db
      .from('chat_history')
      .select(
        'id, user_id, model, llm_finish_reason, llm_charge_id, assistant_reply, status, llm_billing_snapshot'
      )
      .in('id', ids);
    if (historyError)
      throw new Error(`读取待补齐 OpenRouter 对话轮次失败：${historyError.message}`);

    const generationIdByHistoryId = new Map(
      (candidates ?? []).flatMap((row) => {
        const candidate = row as OpenRouterCandidateRow;
        return typeof candidate.chat_history_id === 'string' &&
          typeof candidate.llm_generation_id === 'string' &&
          candidate.llm_generation_id.length > 0
          ? [[candidate.chat_history_id, candidate.llm_generation_id] as const]
          : [];
      })
    );
    return (histories ?? []).flatMap((row) => {
      const parent = row as Omit<ChatHistorySyncRow, 'llm_generation_id'>;
      const generationId = generationIdByHistoryId.get(parent.id);
      return generationId ? [{ ...parent, llm_generation_id: generationId }] : [];
    });
  }
}
