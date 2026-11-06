import type { DomainDb } from '../../lib/supabase.js';
import type { ChatHistorySyncRow } from './ConversationHistoryRepository.js';

/** Surplus has no repository-owned metadata table; its frozen quote is the recovery identity. */
export async function listSurplusRowsPendingBilling(
  db: DomainDb,
  input: { since: string; limit: number }
): Promise<ChatHistorySyncRow[]> {
  const { data, error } = await db
    .from('chat_history')
    .select(
      'id,user_id,model,llm_finish_reason,llm_charge_id,assistant_reply,status,llm_billing_snapshot,llm_billing_settled_at'
    )
    .eq('llm_billing_snapshot->>provider', 'surplus')
    .not('llm_billing_snapshot', 'is', null)
    .is('llm_billing_settled_at', null)
    .neq('status', 'streaming')
    .gte('created_at', input.since)
    .order('created_at', { ascending: true })
    .limit(input.limit)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error('扫描未完成计费的 Surplus 对话失败', { cause: error });
  return (data ?? []).map((row) => ({
    ...row,
    generationId: null,
    callProvider: 'surplus' as const,
  })) as ChatHistorySyncRow[];
}
