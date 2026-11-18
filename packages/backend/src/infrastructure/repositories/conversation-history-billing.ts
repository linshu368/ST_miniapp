import { STREAMING_STALE_SECONDS } from './conversation-history-types.js';
import { LlmModelProviderSchema, type LlmModelProvider } from '@miniapp/shared';
import type { DomainDb } from '../../lib/supabase.js';
import type { ChatHistorySyncRow, LlmBillingSnapshot } from './conversation-history-types.js';

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
  if (error) throw new Error(`回写生成计费结果失败：${error.message}`, { cause: error });
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
  if (error) throw new Error(`回写计费快照失败：${error.message}`, { cause: error });
}

type SettlementScan = LlmModelProvider | 'missing_identity';
type SettlementCandidate = Omit<ChatHistorySyncRow, 'generationId' | 'callProvider'> & {
  delivery_provider: string | null;
  generation_id: string | null;
};

/**
 * 回捞候选只认交付调用的身份：chat_generation_requests.delivery_attempt_id → chat_generation_attempts
 * 的 provider 与 generation_id（数据库重组 6a-2b）。供应商明细表只存用量元数据，不再参与"这一轮由谁交付"。
 * 筛选条件在 experience.list_chat_settlement_candidates 里，每种扫描各自 50 条预算。
 */
async function listSettlementCandidates(
  db: DomainDb,
  scan: SettlementScan,
  input: { since: string; limit: number },
  identityBefore?: string
): Promise<SettlementCandidate[]> {
  const { data, error } = await db
    .rpc('list_chat_settlement_candidates', {
      p_scan: scan,
      p_since: input.since,
      p_limit: input.limit,
      ...(identityBefore ? { p_identity_before: identityBefore } : {}),
    })
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error(`扫描待结算的对话失败（${scan}）`, { cause: error });
  return (data ?? []) as SettlementCandidate[];
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
  const rows = await listSettlementCandidates(db, input.provider, input);
  return rows.map(
    ({ delivery_provider: deliveryProvider, generation_id: generationId, ...row }) => {
      const snapshotProvider = row.llm_billing_snapshot?.provider;
      // A delivered call from another provider (e.g. an OpenRouter fallback beat a Surplus primary) or a
      // quote frozen for another provider is never billed under this provider.
      const conflict =
        (deliveryProvider !== null && deliveryProvider !== input.provider) ||
        (!!snapshotProvider && snapshotProvider !== input.provider);
      return {
        ...row,
        generationId: deliveryProvider === input.provider ? generationId : null,
        callProvider: conflict ? null : input.provider,
      };
    }
  );
}

/** Turns whose delivered call has no generation identity yet, once they can no longer be streaming. */
export async function listRowsMissingProviderIdentity(
  db: DomainDb,
  input: {
    since: string;
    limit: number;
  }
): Promise<ChatHistorySyncRow[]> {
  const before = new Date(Date.now() - STREAMING_STALE_SECONDS * 1000).toISOString();
  const rows = await listSettlementCandidates(db, 'missing_identity', input, before);
  return rows.map(
    ({ delivery_provider: deliveryProvider, generation_id: _generationId, ...row }) => {
      const parsed = LlmModelProviderSchema.safeParse(row.llm_billing_snapshot?.provider);
      const conflict =
        !parsed.success || (deliveryProvider !== null && deliveryProvider !== parsed.data);
      return { ...row, generationId: null, callProvider: conflict ? null : parsed.data };
    }
  );
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
  if (error) throw new Error(`补齐生成完成原因失败：${error.message}`, { cause: error });
}
