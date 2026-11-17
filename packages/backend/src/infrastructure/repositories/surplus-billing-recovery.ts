import type { DomainDb } from '../../lib/supabase.js';
import type { ChatHistorySyncRow } from './ConversationHistoryRepository.js';

function relatedRow(value: unknown): { row: Record<string, unknown> | null; valid: boolean } {
  if (value === null || value === undefined) return { row: null, valid: true };
  const item = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  if (Array.isArray(value) && value.length > 1) return { row: null, valid: false };
  if (Array.isArray(value) && value.length === 0) return { row: null, valid: true };
  return item && typeof item === 'object' && !Array.isArray(item)
    ? { row: item as Record<string, unknown>, valid: true }
    : { row: null, valid: false };
}

/** A losing Surplus call remains observable, but only the frozen delivery quote can be billed. */
export async function listSurplusRowsPendingBilling(
  db: DomainDb,
  input: { since: string; limit: number }
): Promise<ChatHistorySyncRow[]> {
  const { data, error } = await db
    .from('chat_history')
    .select(
      'id,user_id,model,llm_finish_reason,llm_charge_id,assistant_reply,status,llm_billing_snapshot,llm_billing_settled_at,surplusintelligence_chat_history!left(chat_history_id,generation_id,attempt_id),chat_generation_requests!left(chat_history_id,delivery_attempt_id)'
    )
    .eq('llm_billing_snapshot->>provider', 'surplus')
    .not('llm_billing_snapshot', 'is', null)
    .is('llm_billing_settled_at', null)
    .neq('status', 'streaming')
    .gte('created_at', input.since)
    .order('created_at', { ascending: true })
    .limit(Math.min(50, Math.max(1, Math.floor(input.limit))))
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error('扫描未完成计费的 Surplus 对话失败', { cause: error });
  return (data ?? []).map<ChatHistorySyncRow>((candidate) => {
    const { surplusintelligence_chat_history, chat_generation_requests, ...row } = candidate;
    // PostgREST shape can be object or array depending on relationship cardinality metadata.
    const detail = relatedRow(surplusintelligence_chat_history);
    const request = relatedRow(chat_generation_requests);
    const winner = request.row?.delivery_attempt_id;
    const conflict =
      !detail.valid ||
      !request.valid ||
      Boolean(detail.row && detail.row.chat_history_id !== row.id) ||
      Boolean(request.row && request.row.chat_history_id !== row.id) ||
      row.llm_billing_snapshot?.provider !== 'surplus' ||
      Boolean(winner && (!detail.row?.attempt_id || detail.row.attempt_id !== winner));
    return {
      ...row,
      generationId: typeof detail.row?.generation_id === 'string' ? detail.row.generation_id : null,
      callProvider: conflict ? null : 'surplus',
    };
  });
}
