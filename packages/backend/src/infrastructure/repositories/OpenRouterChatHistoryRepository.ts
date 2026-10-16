import type { ChatHistorySyncRow } from './ConversationHistoryRepository.js';
import type { OpenRouterGenerationMetadata } from '../../features/generation/openrouter-metadata.js';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';

export type OpenRouterChatHistoryMetadata = Partial<OpenRouterGenerationMetadata> & {
  chat_history_id: string;
  llm_generation_id?: string | null;
};

interface OpenRouterCandidateRow {
  chat_history_id: string;
  llm_generation_id: string | null;
}

/** Stores only OpenRouter call metadata; parent chat_history remains the business and billing record. */
export class OpenRouterChatHistoryRepository {
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {}

  async ensurePlaceholder(chatHistoryId: string): Promise<void> {
    const { error } = await this.db
      .from('openrouter_chat_history')
      .upsert(
        { chat_history_id: chatHistoryId },
        { onConflict: 'chat_history_id', ignoreDuplicates: true }
      )
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error('保存 OpenRouter 调用占位失败', { cause: error });
  }

  async ensureGenerationId(chatHistoryId: string, generationId: string): Promise<void> {
    if (!generationId.trim()) throw new Error('调用 ID 为空');
    const deadline = AbortSignal.timeout(10_000);
    await this.ensurePlaceholder(chatHistoryId);
    // Only fill an empty identity. A late replica can never replace an existing call.
    for (let attempt = 0; attempt < 2; attempt++) {
      deadline.throwIfAborted();
      const write = await this.db
        .from('openrouter_chat_history')
        .update({ llm_generation_id: generationId, updated_at: new Date().toISOString() })
        .eq('chat_history_id', chatHistoryId)
        .is('llm_generation_id', null)
        .select('llm_generation_id')
        .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(5_000)]))
        .maybeSingle();
      if (!write.error && write.data) return;
      // A timed out write may have committed: read back before retrying the same identity.
      const read = await this.db
        .from('openrouter_chat_history')
        .select('llm_generation_id')
        .eq('chat_history_id', chatHistoryId)
        .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(5_000)]))
        .maybeSingle();
      if (!read.error && read.data?.llm_generation_id === generationId) return;
      if (!read.error && read.data?.llm_generation_id) throw new Error('OpenRouter 调用 ID 冲突');
      if (attempt === 1)
        throw new Error('保存 OpenRouter 调用 ID 未确认', { cause: write.error ?? read.error });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async upsert(metadata: OpenRouterChatHistoryMetadata): Promise<void> {
    const { llm_generation_id: generationId, ...fields } = metadata;
    if (generationId) await this.ensureGenerationId(metadata.chat_history_id, generationId);
    else await this.ensurePlaceholder(metadata.chat_history_id);
    const { error } = await this.db
      .from('openrouter_chat_history')
      .upsert(
        {
          // Missing upstream fields are not evidence that a previously observed value vanished.
          ...Object.fromEntries(
            Object.entries(fields).filter(([, value]) => value !== null && value !== undefined)
          ),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'chat_history_id' }
      )
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(`回写 OpenRouter 调用明细失败：${error.message}`);
  }

  async readGenerationData(chatHistoryId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.db
      .from('openrouter_chat_history')
      .select(
        'provider_name,finish_reason,usage,usage_cache,native_tokens_cached,native_tokens_reasoning,native_tokens_completion,native_tokens_prompt,latency,generation_time,model'
      )
      .eq('chat_history_id', chatHistoryId)
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();
    if (error) throw new Error('读取 OpenRouter 已存调用事实失败', { cause: error });
    return data;
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
        'llm_generation_data.is.null,usage.is.null,latency.is.null,generation_time.is.null,finish_reason.is.null'
      )
      .order('created_at', { ascending: false })
      .limit(input.limit)
      .abortSignal(AbortSignal.timeout(5_000));
    if (candidateError)
      throw new Error(`扫描待补齐的 OpenRouter 调用明细失败：${candidateError.message}`);

    const ids = (candidates ?? [])
      .map((row) => (row as OpenRouterCandidateRow).chat_history_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return [];

    const { data: histories, error: historyError } = await this.db
      .from('chat_history')
      .select(
        'id, user_id, model, llm_finish_reason, llm_charge_id, assistant_reply, status, llm_billing_snapshot,venice_chat_history!left(chat_history_id)'
      )
      .in('id', ids)
      .abortSignal(AbortSignal.timeout(5_000));
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
      const parent = row as Omit<ChatHistorySyncRow, 'generationId' | 'callProvider'>;
      const generationId = generationIdByHistoryId.get(parent.id);
      const conflict =
        !!(parent as typeof parent & { venice_chat_history?: unknown }).venice_chat_history ||
        !!(
          parent.llm_billing_snapshot?.provider &&
          parent.llm_billing_snapshot.provider !== 'openrouter'
        );
      return generationId && parent.status !== 'streaming'
        ? [{ ...parent, generationId, callProvider: conflict ? null : ('openrouter' as const) }]
        : [];
    });
  }
}
