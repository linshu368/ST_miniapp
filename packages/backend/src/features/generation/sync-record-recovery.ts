import type { FastifyBaseLogger } from 'fastify';
import type { LlmModelProvider } from '@miniapp/shared';
import { GenerationObservationRepository } from '../../infrastructure/repositories/GenerationObservationRepository.js';
import {
  ConversationHistoryRepository,
  type ChatHistorySyncRow,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { OpenRouterChatHistoryRepository } from '../../infrastructure/repositories/OpenRouterChatHistoryRepository.js';
import {
  buildGenerationMetadata,
  fetchGenerationData,
  hasOpenRouterKey,
  isCompleteGenerationData,
} from './openrouter-metadata.js';
import { reconcileFixedProviderRecord } from './fixed-provider-recovery.js';
import { reconcileCharge, type ReconciledChargeResult } from './sync-charge-recovery.js';

export type SyncRecordOutcome =
  | 'completed'
  | 'error_data'
  | 'not_ready'
  | 'recovered'
  | 'manual_audit'
  | 'budget_deferred'
  | 'failed';
export interface SyncRecordInput {
  record: ChatHistorySyncRow;
  storedGenerationData: Map<string, Record<string, unknown>>;
  allowProviderFetch: boolean;
  log: FastifyBaseLogger;
}
let historyRepository: ConversationHistoryRepository | null = null;
let openRouterHistoryRepository: OpenRouterChatHistoryRepository | null = null;
export function syncHistory(): ConversationHistoryRepository {
  return (historyRepository ??= new ConversationHistoryRepository());
}
export function syncOpenRouterHistory(): OpenRouterChatHistoryRepository {
  return (openRouterHistoryRepository ??= new OpenRouterChatHistoryRepository());
}

export async function processSyncRecord(input: SyncRecordInput): Promise<SyncRecordOutcome> {
  const { record, log } = input;
  if (record.status === 'streaming') {
    if (record.session_id) await syncHistory().recoverStaleStreaming(record.session_id);
    return 'recovered';
  }
  const generationId = record.generationId;
  const provider = resolveSyncProvider(record, log);
  if (!provider) return 'manual_audit';
  if (record.llm_billing_settled_at && (provider !== 'openrouter' || !generationId))
    return 'completed';
  if (provider !== 'openrouter' && (generationId || provider === 'surplus')) {
    const outcome = await reconcileFixedProviderRecord({
      record,
      generationId,
      provider,
      log,
      history: syncHistory(),
      reconcile: reconcileCharge,
    });
    return outcome === 'settled' ? 'completed' : 'not_ready';
  }
  if (!generationId) return recoverMissingIdentity(record, log);
  return recoverOpenRouterRecord({ ...input, generationId });
}

async function recoverMissingIdentity(
  record: ChatHistorySyncRow,
  log: FastifyBaseLogger
): Promise<SyncRecordOutcome> {
  // A crash cannot reconstruct an upstream locator. Only already-determined failures can settle.
  if (record.status !== 'success' && record.llm_charge_id) {
    try {
      const result = await reconcileCharge({
        record,
        generationId: null,
        genData: {},
        finishReason: record.llm_finish_reason ?? 'error',
      });
      if (!result.settled) return 'not_ready';
      await syncHistory().recordBillingOutcome({
        historyId: record.id,
        intendedDeduction: result.intendedDeduction,
        deductionRate: result.deductionRate,
        billingSettledAt: new Date().toISOString(),
      });
      return 'completed';
    } catch (err) {
      log.error(
        { err, event: 'chathistory_sync.identity_cleanup_failed', id: record.id },
        'failed call cleanup pending'
      );
      return 'failed';
    }
  }
  log.warn(
    { event: 'chathistory_sync.identity_missing', id: record.id },
    'call identity unavailable; manual audit required'
  );
  return 'manual_audit';
}

async function recoverOpenRouterRecord(
  input: SyncRecordInput & { generationId: string }
): Promise<SyncRecordOutcome> {
  const { record, storedGenerationData, allowProviderFetch, generationId, log } = input;
  const stored = storedGenerationData.get(record.id) ?? null;
  const storedComplete = isCompleteGenerationData(stored);
  if (!storedComplete && hasOpenRouterKey() && !allowProviderFetch) return 'budget_deferred';
  const fetched =
    !storedComplete && hasOpenRouterKey() ? await fetchGenerationData(generationId) : null;
  const genData = storedComplete ? stored : (fetched ?? stored);
  if (!genData) return 'not_ready';
  const providerMetadata = buildGenerationMetadata(genData);
  if (
    fetched &&
    hasGenerationMetadataChanged(stored, providerMetadata) &&
    !(await persistOpenRouterMetadata(input, providerMetadata))
  )
    return 'failed';
  // Metadata repair must not reopen a settled charge whose full detail may already be pruned.
  if (record.llm_billing_settled_at)
    return isCompleteGenerationData(genData) ? 'completed' : 'not_ready';
  const local = record.llm_finish_reason;
  const finishReason =
    local === 'cancelled' || local === 'user_cancelled' || local === 'timeout'
      ? local
      : providerMetadata.finish_reason;
  if (typeof finishReason !== 'string') return genData.error ? 'error_data' : 'not_ready';
  const result = await reconcileAndStore({
    record,
    generationId,
    finishReason,
    log,
    genData: { usage: providerMetadata.usage, model: providerMetadata.model },
  });
  if (result === null) return 'failed';
  return isCompleteGenerationData(genData) && result.settled ? 'completed' : 'not_ready';
}

async function persistOpenRouterMetadata(
  input: SyncRecordInput & { generationId: string },
  metadata: ReturnType<typeof buildGenerationMetadata>
): Promise<boolean> {
  const { record, generationId, log } = input;
  try {
    await new GenerationObservationRepository().enrichGeneration(generationId, metadata);
  } catch (err) {
    log.warn(
      { err, event: 'llm.attempt.provider_metadata_failed', id: record.id, generationId },
      '供应商观测未补齐'
    );
  }
  try {
    await syncOpenRouterHistory().updateKnownGenerationMetadata({
      chat_history_id: record.id,
      llm_generation_id: generationId,
      ...metadata,
    });
    return true;
  } catch (err) {
    log.error(
      {
        kind: 'sys',
        event: 'chathistory_sync.openrouter_metadata_failed',
        err,
        id: record.id,
        generationId,
      },
      'failed to update OpenRouter generation metadata'
    );
    return false;
  }
}

async function reconcileAndStore(input: {
  record: ChatHistorySyncRow;
  generationId: string;
  genData: Record<string, unknown>;
  finishReason: string;
  log: FastifyBaseLogger;
}): Promise<ReconciledChargeResult | null> {
  const { record, generationId, genData, finishReason, log } = input;
  let reconciled: ReconciledChargeResult;
  try {
    reconciled = await reconcileCharge({ record, generationId, genData, finishReason });
  } catch (err) {
    log.error(
      {
        kind: 'sys',
        event: 'chathistory_sync.reconcile_failed',
        err,
        id: record.id,
        generationId,
        chargeId: record.llm_charge_id,
      },
      'failed to reconcile LLM usage charge'
    );
    return null;
  }
  try {
    await syncHistory().recordBillingOutcome({
      historyId: record.id,
      intendedDeduction: reconciled.intendedDeduction,
      deductionRate: reconciled.deductionRate,
      finishReason,
      ...(reconciled.settled ? { billingSettledAt: new Date().toISOString() } : {}),
    });
    return reconciled;
  } catch (err) {
    log.error(
      { kind: 'sys', event: 'chathistory_sync.update_failed', err, id: record.id, generationId },
      'failed to update chat history'
    );
    return null;
  }
}

function resolveSyncProvider(
  record: ChatHistorySyncRow,
  log: FastifyBaseLogger
): LlmModelProvider | null {
  const provider = record.callProvider;
  if (
    provider &&
    (!record.llm_billing_snapshot?.provider || record.llm_billing_snapshot.provider === provider)
  )
    return provider;
  log.error(
    { event: 'chathistory_sync.provider_unresolved', id: record.id },
    'call provider requires audit'
  );
  return null;
}

function hasGenerationMetadataChanged(
  stored: Record<string, unknown> | null,
  next: ReturnType<typeof buildGenerationMetadata>
): boolean {
  if (!stored) return true;
  return Object.entries(next).some(
    ([key, value]) =>
      value !== null && value !== undefined && stableJson(value) !== stableJson(stored[key])
  );
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
    .join(',')}}`;
}
