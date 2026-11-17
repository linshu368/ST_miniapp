import type { FastifyBaseLogger } from 'fastify';
import type { LlmModelProvider } from '@miniapp/shared';
import type {
  ChatHistorySyncRow,
  ConversationHistoryRepository,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';

interface ReconciledChargeResult {
  settled: boolean;
  intendedDeduction?: number;
  deductionRate?: number;
}

export async function reconcileFixedProviderRecord(input: {
  record: ChatHistorySyncRow;
  generationId: string | null;
  provider: Exclude<LlmModelProvider, 'openrouter'>;
  log: FastifyBaseLogger;
  history: Pick<ConversationHistoryRepository, 'recordBillingOutcome'>;
  reconcile: (input: {
    record: ChatHistorySyncRow;
    generationId: string | null;
    genData: Record<string, unknown>;
    finishReason: string | null;
  }) => Promise<ReconciledChargeResult>;
}): Promise<'settled' | 'not_ready'> {
  const { record, generationId, provider, log } = input;
  const finishReason = record.llm_finish_reason;
  if (typeof finishReason !== 'string') return 'not_ready';

  const model = record.llm_billing_snapshot?.provider_model_id ?? record.model;
  let reconciled: ReconciledChargeResult;
  try {
    reconciled = await input.reconcile({
      record,
      generationId,
      genData: { model, finish_reason: finishReason },
      finishReason,
    });
  } catch (err) {
    log.error(
      {
        kind: 'sys',
        event: 'chathistory_sync.non_openrouter_reconcile_failed',
        err,
        id: record.id,
        provider,
        generationId,
        chargeId: record.llm_charge_id,
      },
      'failed to reconcile non-OpenRouter LLM usage charge'
    );
    return 'not_ready';
  }

  try {
    await input.history.recordBillingOutcome({
      historyId: record.id,
      intendedDeduction: reconciled.intendedDeduction,
      deductionRate: reconciled.deductionRate,
      finishReason,
      ...(reconciled.settled ? { billingSettledAt: new Date().toISOString() } : {}),
    });
  } catch (err) {
    log.error(
      {
        kind: 'sys',
        event: 'chathistory_sync.non_openrouter_update_failed',
        err,
        id: record.id,
        provider,
        generationId,
      },
      'failed to update non-OpenRouter chat history'
    );
    return 'not_ready';
  }

  return reconciled.settled ? 'settled' : 'not_ready';
}
