import { STREAMING_STALE_SECONDS } from './conversation-history-types.js';
import { LlmModelProviderSchema, type LlmModelProvider } from '@miniapp/shared';
import type { DomainDb } from '../../lib/supabase.js';
import type { ChatHistorySyncRow, LlmBillingSnapshot } from './conversation-history-types.js';
import { listSurplusRowsPendingBilling } from './surplus-billing-recovery.js';

/**
 * 生成终态结算：实扣金额、计费意图与结算完成时间。
 * 由 features/generation/settle.ts 与 sync-job.ts 调用。
 * OpenRouter 元数据由专用 repository 写入；这里仅接受仍属主表的计费字段。
 * billingSettledAt 有值才表示扣费行、额度收口、金额回写都齐；不要用元数据是否齐全代替。
 */
export async function recordBillingOutcome(
  db: DomainDb,
  input: {
    historyId: string;
    deductionRate?: number;
    intendedDeduction?: number;
    finishReason?: string | null;
    billingSettledAt?: string;
  }
): Promise<void> {
  const { error } = await db
    .from('chat_history')
    .update({
      ...(input.deductionRate !== undefined ? { deduction_rate: input.deductionRate } : {}),
      ...(input.intendedDeduction !== undefined
        ? { llm_intended_deduction: input.intendedDeduction }
        : {}),
      ...(input.billingSettledAt ? { llm_billing_settled_at: input.billingSettledAt } : {}),
    })
    .eq('id', input.historyId)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error(`回写生成计费结果失败：${error.message}`);
  await applySuccessfulFinishReason(db, input.historyId, input.finishReason);
}

/**
 * 扣费前先落下请求时定价快照。charge 行还没建出来时，回捞靠它按原价补建。
 * 由 features/generation/settle.ts 调用；不碰用量元数据列。
 */
export async function saveBillingSnapshot(
  db: DomainDb,
  historyId: string,
  snapshot: LlmBillingSnapshot
): Promise<void> {
  const { error } = await db
    .from('chat_history')
    .update({ llm_billing_snapshot: snapshot })
    .eq('id', historyId)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error(`回写计费快照失败：${error.message}`);
}

/** Each provider gets its own budget so incomplete metadata cannot hide completed-call billing. */
export async function listRowsPendingBilling(
  db: DomainDb,
  input: {
    since: string;
    limit: number;
    provider: LlmModelProvider;
  }
): Promise<ChatHistorySyncRow[]> {
  if (input.provider === 'surplus') return listSurplusRowsPendingBilling(db, input);

  const table = input.provider === 'openrouter' ? 'openrouter_chat_history' : 'venice_chat_history';
  const other =
    table === 'openrouter_chat_history' ? 'venice_chat_history' : 'openrouter_chat_history';
  const { data, error } = await db
    .from('chat_history')
    .select(
      `id,user_id,model,llm_finish_reason,llm_charge_id,assistant_reply,status,llm_billing_snapshot,llm_billing_settled_at,${table}!inner(llm_generation_id),${other}!left(llm_generation_id)`
    )
    .not(`${table}.llm_generation_id`, 'is', null)
    .not('llm_billing_snapshot', 'is', null)
    .is('llm_billing_settled_at', null)
    .neq('status', 'streaming')
    .gte('created_at', input.since)
    .order('created_at', { ascending: true })
    .limit(input.limit)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error('扫描未完成计费的对话失败', { cause: error });
  return (data ?? []).map((row) => mapProviderSyncRow(row, table));
}

/** Missing identities remain observable after removing the legacy parent ID. */
export async function listRowsMissingProviderIdentity(
  db: DomainDb,
  input: {
    since: string;
    limit: number;
  }
): Promise<ChatHistorySyncRow[]> {
  const { data, error } = await db
    .from('chat_history')
    .select(
      'id,user_id,model,session_id,llm_finish_reason,llm_charge_id,assistant_reply,status,llm_billing_snapshot,llm_billing_settled_at,openrouter_chat_history!left(llm_generation_id),venice_chat_history!left(llm_generation_id),or_presence:openrouter_chat_history!left(chat_history_id),venice_presence:venice_chat_history!left(chat_history_id)'
    )
    .not('openrouter_chat_history.llm_generation_id', 'is', null)
    .not('venice_chat_history.llm_generation_id', 'is', null)
    .is('openrouter_chat_history', null)
    .is('venice_chat_history', null)
    .not('llm_billing_snapshot', 'is', null)
    .is('llm_billing_settled_at', null)
    .gte('created_at', input.since)
    .lt('created_at', new Date(Date.now() - STREAMING_STALE_SECONDS * 1000).toISOString())
    .order('created_at', { ascending: true })
    .limit(input.limit)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error('扫描缺失调用身份的对话失败', { cause: error });
  return (data ?? []).map((row) => {
    const provider = row.llm_billing_snapshot?.provider;
    const parsedProvider = LlmModelProviderSchema.safeParse(provider);
    const conflict =
      (row.or_presence && row.venice_presence) ||
      (row.or_presence && provider !== 'openrouter') ||
      (row.venice_presence && provider !== 'venice');
    return {
      ...row,
      generationId: null,
      callProvider: conflict || !parsedProvider.success ? null : parsedProvider.data,
    };
  }) as ChatHistorySyncRow[];
}

/** A restarted execution owner must not leave a durable quota/session reservation busy. */
export async function listStaleStreaming(
  db: DomainDb,
  input: { since: string; limit: number }
): Promise<ChatHistorySyncRow[]> {
  const { data, error } = await db
    .from('chat_history')
    .select(
      'id,user_id,model,session_id,llm_finish_reason,llm_charge_id,assistant_reply,status,llm_billing_snapshot,llm_billing_settled_at'
    )
    .eq('status', 'streaming')
    .gte('created_at', input.since)
    .lt('created_at', new Date(Date.now() - STREAMING_STALE_SECONDS * 1000).toISOString())
    .order('created_at', { ascending: true })
    .limit(input.limit)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error('扫描超时对话失败', { cause: error });
  return (data ?? []).map((row) => ({
    ...row,
    generationId: null,
    callProvider: null,
  })) as ChatHistorySyncRow[];
}

export async function applySuccessfulFinishReason(
  db: DomainDb,
  historyId: string,
  finishReason: string | null | undefined
): Promise<void> {
  if (typeof finishReason !== 'string') return;
  const { error } = await db
    .from('chat_history')
    .update({ llm_finish_reason: finishReason })
    .eq('id', historyId)
    .eq('status', 'success')
    .or(
      'llm_finish_reason.is.null,and(llm_finish_reason.neq.cancelled,llm_finish_reason.neq.user_cancelled,llm_finish_reason.neq.timeout)'
    )
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error(`补齐生成完成原因失败：${error.message}`);
}

function mapProviderSyncRow(
  value: unknown,
  table: 'openrouter_chat_history' | 'venice_chat_history'
): ChatHistorySyncRow {
  const row = value as Omit<ChatHistorySyncRow, 'generationId' | 'callProvider'> & {
    openrouter_chat_history?: { llm_generation_id: string | null };
    venice_chat_history?: { llm_generation_id: string | null };
  };
  const provider = table === 'openrouter_chat_history' ? 'openrouter' : 'venice';
  const conflict =
    !!(row.openrouter_chat_history && row.venice_chat_history) ||
    !!(row.llm_billing_snapshot?.provider && row.llm_billing_snapshot.provider !== provider);
  return {
    ...row,
    generationId: row[table]?.llm_generation_id ?? null,
    callProvider: conflict ? null : provider,
  };
}
