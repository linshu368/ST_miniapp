/**
 * backend / features / generation / sync-job.ts
 *
 * 生成计费的第二条结算路径：进程内 30 秒轮询，回捞 24h 内元数据不全
 * 或结算未完成的轮次。
 *
 * 为什么需要它：OpenRouter 的用量统计是异步的，settle.ts 那一次即时拉取经常拿不到
 * finish_reason。没有 finish_reason 就不能判「是否自然收尾」，于是计费挂 pending
 * （见 §finish_reason 计费闸门）。本任务负责把这些 pending 行结算掉；也负责把
 * 「元数据齐了、账没结」的行按请求时快照补建 charge、补额度收口、补金额回写。
 *
 * 它和 settle.ts 是同一个行为的两条路径，所以刻意放在同一个模块下：
 * 用量元数据的字段映射共用 openrouter-metadata.ts，定档扣费拼装共用
 * apply-charge.ts，chat_history 的写入共用 ConversationHistoryRepository。
 * 不允许任何一边私开第二套。
 */

import type { FastifyBaseLogger } from 'fastify';
import { GenerationObservationRepository } from '../../infrastructure/repositories/GenerationObservationRepository.js';
import { LlmModelProviderSchema, type LlmModelProvider } from '@miniapp/shared';
import { calculateUsageDeduction } from '../billing/usage-pricing.js';
import {
  ConversationHistoryRepository,
  type ChatHistorySyncRow,
  type LlmBillingSnapshot,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { OpenRouterChatHistoryRepository } from '../../infrastructure/repositories/OpenRouterChatHistoryRepository.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import { applyLlmCharge } from './apply-charge.js';
import { frozenLlmChargeMetadata } from './text-billing.js';
import {
  buildGenerationMetadata,
  fetchGenerationData,
  hasOpenRouterKey,
  isCompleteGenerationData,
} from './openrouter-metadata.js';

const SYNC_INTERVAL_MS = 30 * 1000;
const STARTUP_DELAY_MS = 5 * 1000;
const LOOKBACK_HOURS = 24;
const BATCH_LIMIT = 50;
/** 扫描阶段最多并行占几条共享池连接；5 路全开会在池紧张时与大厅读路径抢额度。 */
const SCAN_CONCURRENCY = 2;
/** 行处理会同时触发 provider 与数据库调用；3 路在缩短墙钟时间和保护共享池之间取中间值。 */
const RECORD_CONCURRENCY = 3;
/** Even with a 5s provider timeout, a cold backlog stays below one 30s scheduler interval. */
const PROVIDER_FETCH_BUDGET = 9;
const NOT_READY_BACKOFF_BASE_MS = SYNC_INTERVAL_MS;
const NOT_READY_BACKOFF_MAX_MS = 4 * 60 * 1000;
const RETRY_STATE_TTL_MS = LOOKBACK_HOURS * 60 * 60 * 1000;
const RETRY_STATE_LIMIT = 2_000;

interface RetryState {
  fingerprint: string;
  attempts: number;
  nextRetryAt: number;
  firstSeenAt: number;
}

type SyncRecordOutcome =
  | 'completed'
  | 'error_data'
  | 'not_ready'
  | 'recovered'
  | 'manual_audit'
  | 'budget_deferred'
  | 'failed';

let timerId: NodeJS.Timeout | null = null;
let startupTimerId: NodeJS.Timeout | null = null;
let isRunning = false;
let walletRepository: MiniappWalletRepository | null = null;
let historyRepository: ConversationHistoryRepository | null = null;
let openRouterHistoryRepository: OpenRouterChatHistoryRepository | null = null;
const retryStates = new Map<string, RetryState>();

/** 保持 allSettled 语义，但限制同时 in-flight 的任务数，降低对 Prisma 共享池的尖峰占用。 */
async function runSettledWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<Array<PromiseSettledResult<T>>> {
  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (!task) continue;
      try {
        results[index] = { status: 'fulfilled', value: await task() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function wallets(): MiniappWalletRepository {
  return (walletRepository ??= new MiniappWalletRepository());
}

function history(): ConversationHistoryRepository {
  return (historyRepository ??= new ConversationHistoryRepository());
}

function openRouterHistory(): OpenRouterChatHistoryRepository {
  return (openRouterHistoryRepository ??= new OpenRouterChatHistoryRepository());
}

export function startChatHistorySyncJob(log: FastifyBaseLogger): void {
  if (timerId || startupTimerId) return;

  const jlog = log.child({ module: 'chat-history-sync' });

  timerId = setInterval(() => {
    void runSyncJob(jlog);
  }, SYNC_INTERVAL_MS);

  startupTimerId = setTimeout(() => {
    startupTimerId = null;
    void runSyncJob(jlog);
  }, STARTUP_DELAY_MS);

  jlog.info({ kind: 'sys', event: 'chathistory_sync.started' }, 'Chat history sync job started');
}

export function stopChatHistorySyncJob(): void {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }

  if (startupTimerId) {
    clearTimeout(startupTimerId);
    startupTimerId = null;
  }

  retryStates.clear();
}

async function runSyncJob(log: FastifyBaseLogger): Promise<void> {
  if (isRunning) {
    log.info('[sync-job] previous run is still active, skipping this tick');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

    const input = { since, limit: BATCH_LIMIT };
    // Separate budgets keep a metadata backlog from hiding billing recovery.
    // A failed metadata scan must not prevent the independent billing repair.
    // 有界并发：避免每 30s 一次占满共享池的 5 条连接。
    const scanTasks = [
      () => history().listRowsPendingBilling({ ...input, provider: 'openrouter' }),
      () => history().listRowsPendingBilling({ ...input, provider: 'venice' }),
      () => history().listRowsMissingProviderIdentity(input),
      () => openRouterHistory().listRowsMissingGenerationData(input),
      () => history().listStaleStreaming(input),
    ];
    const scans = await runSettledWithConcurrency(scanTasks, SCAN_CONCURRENCY);
    const rowsById = new Map<string, ChatHistorySyncRow>();
    for (const [index, scan] of scans.entries()) {
      if (scan.status === 'rejected') {
        log.error(
          {
            kind: 'sys',
            event: 'chathistory_sync.fetch_failed',
            err: scan.reason,
            source: [
              'openrouter_billing',
              'venice_billing',
              'missing_identity',
              'metadata',
              'stale_streaming',
            ][index],
          },
          'failed to fetch incomplete chat history'
        );
        continue;
      }
      for (const row of scan.value) if (!rowsById.has(row.id)) rowsById.set(row.id, row);
    }
    const rows = [...rowsById.values()];
    pruneRetryStates(Date.now());

    if (rows.length === 0) {
      log.info(
        {
          kind: 'sys',
          event: 'chathistory_sync.finished',
          scannedCount: 0,
          eligibleCount: 0,
          deferredCount: 0,
          durationMs: Date.now() - startedAt,
        },
        '[sync-job] sync run finished'
      );
      return;
    }

    const now = Date.now();
    const eligibleRows: ChatHistorySyncRow[] = [];
    let deferredCount = 0;
    for (const record of rows) {
      if (record.status !== 'streaming' && shouldDeferRecord(record, now)) deferredCount++;
      else eligibleRows.push(record);
    }

    const openRouterIds = eligibleRows
      .filter(
        (record) =>
          record.status !== 'streaming' &&
          record.callProvider === 'openrouter' &&
          !!record.generationId
      )
      .map((record) => record.id);
    let storedGenerationData = new Map<string, Record<string, unknown>>();
    let openRouterBatchReadFailed = false;
    if (openRouterIds.length > 0) {
      try {
        storedGenerationData = await openRouterHistory().readGenerationDataBatch(openRouterIds);
      } catch (err) {
        openRouterBatchReadFailed = true;
        log.error(
          { kind: 'sys', event: 'chathistory_sync.metadata_batch_read_failed', err },
          'failed to batch-read OpenRouter generation metadata'
        );
      }
    }

    let providerFetchBudget = PROVIDER_FETCH_BUDGET;

    const results = await runSettledWithConcurrency(
      eligibleRows.map((record) => async () => {
        if (
          openRouterBatchReadFailed &&
          record.status !== 'streaming' &&
          record.callProvider === 'openrouter' &&
          !!record.generationId
        ) {
          return 'failed' as const;
        }
        const stored = storedGenerationData.get(record.id) ?? null;
        const requiresProviderFetch =
          record.callProvider === 'openrouter' &&
          !!record.generationId &&
          hasOpenRouterKey() &&
          !isCompleteGenerationData(stored);
        const allowProviderFetch = !requiresProviderFetch || providerFetchBudget-- > 0;
        return processSyncRecord({
          record,
          storedGenerationData,
          allowProviderFetch,
          log,
        });
      }),
      RECORD_CONCURRENCY
    );

    const counts: Record<SyncRecordOutcome, number> = {
      completed: 0,
      error_data: 0,
      not_ready: 0,
      recovered: 0,
      manual_audit: 0,
      budget_deferred: 0,
      failed: 0,
    };
    for (const [index, result] of results.entries()) {
      const record = eligibleRows[index];
      if (!record) continue;
      if (result.status === 'rejected') {
        counts.failed++;
        log.error(
          { err: result.reason, event: 'chathistory_sync.record_failed', id: record.id },
          'record deferred; remaining candidates continue'
        );
        continue;
      }

      counts[result.value]++;
      if (
        result.value === 'not_ready' ||
        result.value === 'error_data' ||
        result.value === 'manual_audit'
      ) {
        registerRetryState(record, Date.now());
      } else if (result.value !== 'failed') {
        retryStates.delete(record.id);
      }
    }

    log.info(
      {
        kind: 'sys',
        event: 'chathistory_sync.finished',
        scannedCount: rows.length,
        eligibleCount: eligibleRows.length,
        deferredCount,
        completedCount: counts.completed,
        recoveredCount: counts.recovered,
        errorDataCount: counts.error_data,
        notReadyCount: counts.not_ready,
        manualAuditCount: counts.manual_audit,
        providerBudgetDeferredCount: counts.budget_deferred,
        failedCount: counts.failed,
        retryStateSize: retryStates.size,
        durationMs: Date.now() - startedAt,
      },
      '[sync-job] sync run finished'
    );
  } catch (err) {
    log.error({ kind: 'sys', event: 'chathistory_sync.unexpected', err }, 'unexpected error');
  } finally {
    isRunning = false;
  }
}

async function processSyncRecord(input: {
  record: ChatHistorySyncRow;
  storedGenerationData: Map<string, Record<string, unknown>>;
  allowProviderFetch: boolean;
  log: FastifyBaseLogger;
}): Promise<SyncRecordOutcome> {
  const { record, storedGenerationData, allowProviderFetch, log } = input;
  if (record.status === 'streaming') {
    if (record.session_id) await history().recoverStaleStreaming(record.session_id);
    return 'recovered';
  }

  const generationId = record.generationId;
  const provider = record.callProvider;
  if (
    !provider ||
    (record.llm_billing_snapshot?.provider && record.llm_billing_snapshot.provider !== provider)
  ) {
    log.error(
      { event: 'chathistory_sync.provider_unresolved', id: record.id },
      'call provider requires audit'
    );
    return 'manual_audit';
  }

  if (!generationId) {
    // No upstream locator can be reconstructed after a crash. Only release an
    // already-determined failed/cancelled call; never infer stop or regenerate.
    if (record.status !== 'success' && record.llm_charge_id) {
      try {
        const result = await reconcileCharge({
          record,
          generationId: null,
          genData: {},
          finishReason: record.llm_finish_reason ?? 'error',
        });
        if (!result.settled) return 'not_ready';
        await history().recordBillingOutcome({
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

  if (provider !== 'openrouter') {
    const reconciled = await reconcileNonOpenRouterRecord({ record, generationId, provider, log });
    return reconciled === 'settled' ? 'completed' : 'not_ready';
  }

  const stored = storedGenerationData.get(record.id) ?? null;
  const storedComplete = isCompleteGenerationData(stored);
  if (!storedComplete && hasOpenRouterKey() && !allowProviderFetch) return 'budget_deferred';
  const fetched =
    !storedComplete && hasOpenRouterKey() ? await fetchGenerationData(generationId) : null;
  const genData = storedComplete ? stored : (fetched ?? stored);
  if (!genData) return 'not_ready';

  const providerMetadata = buildGenerationMetadata(genData);
  const metadataChanged = !!fetched && hasGenerationMetadataChanged(stored, providerMetadata);
  if (metadataChanged) {
    try {
      await new GenerationObservationRepository().enrichGeneration(generationId, providerMetadata);
    } catch (err) {
      log.warn(
        { err, event: 'llm.attempt.provider_metadata_failed', id: record.id, generationId },
        '供应商观测未补齐'
      );
    }
    try {
      await openRouterHistory().updateKnownGenerationMetadata({
        chat_history_id: record.id,
        llm_generation_id: generationId,
        ...providerMetadata,
      });
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
      return 'failed';
    }
  }

  // Local cancellation/deadline remains the billing outcome even if upstream later stops.
  const finishReason =
    record.llm_finish_reason === 'cancelled' ||
    record.llm_finish_reason === 'user_cancelled' ||
    record.llm_finish_reason === 'timeout'
      ? record.llm_finish_reason
      : providerMetadata.finish_reason;
  // Without a terminal reason, billing cannot progress. Avoid a charge lookup and an empty update.
  if (typeof finishReason !== 'string') return genData.error ? 'error_data' : 'not_ready';

  let reconciled: ReconciledChargeResult;
  try {
    reconciled = await reconcileCharge({
      record,
      generationId,
      genData: { usage: providerMetadata.usage, model: providerMetadata.model },
      finishReason,
    });
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
    return 'failed';
  }

  try {
    await history().recordBillingOutcome({
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
        event: 'chathistory_sync.update_failed',
        err,
        id: record.id,
        generationId,
      },
      'failed to update chat history'
    );
    return 'failed';
  }

  return isCompleteGenerationData(genData) && reconciled.settled ? 'completed' : 'not_ready';
}

function syncRecordFingerprint(record: ChatHistorySyncRow): string {
  return [
    record.callProvider ?? '',
    record.generationId ?? '',
    record.status,
    record.llm_finish_reason ?? '',
    record.llm_charge_id ?? '',
  ].join('\u001f');
}

function shouldDeferRecord(record: ChatHistorySyncRow, now: number): boolean {
  const state = retryStates.get(record.id);
  if (!state) return false;
  if (now - state.firstSeenAt >= RETRY_STATE_TTL_MS) {
    retryStates.delete(record.id);
    return false;
  }
  if (state.fingerprint !== syncRecordFingerprint(record)) {
    retryStates.delete(record.id);
    return false;
  }
  return now < state.nextRetryAt;
}

function registerRetryState(record: ChatHistorySyncRow, now: number): void {
  const fingerprint = syncRecordFingerprint(record);
  const previous = retryStates.get(record.id);
  const attempts = previous?.fingerprint === fingerprint ? previous.attempts + 1 : 0;
  const delayMs = Math.min(NOT_READY_BACKOFF_BASE_MS * 2 ** attempts, NOT_READY_BACKOFF_MAX_MS);

  pruneRetryStates(now);
  if (!retryStates.has(record.id) && retryStates.size >= RETRY_STATE_LIMIT) {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, state] of retryStates) {
      if (state.firstSeenAt < oldestAt) {
        oldestId = id;
        oldestAt = state.firstSeenAt;
      }
    }
    if (oldestId) retryStates.delete(oldestId);
  }

  retryStates.set(record.id, {
    fingerprint,
    attempts,
    nextRetryAt: now + delayMs,
    firstSeenAt: previous?.fingerprint === fingerprint ? previous.firstSeenAt : now,
  });
}

function pruneRetryStates(now: number): void {
  for (const [id, state] of retryStates) {
    if (now - state.firstSeenAt >= RETRY_STATE_TTL_MS) retryStates.delete(id);
  }
}

function hasGenerationMetadataChanged(
  stored: Record<string, unknown> | null,
  next: ReturnType<typeof buildGenerationMetadata>
): boolean {
  if (!stored) return true;
  return Object.entries(next).some(([key, value]) => {
    if (value === null || value === undefined) return false;
    return stableJson(value) !== stableJson(stored[key]);
  });
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

async function reconcileNonOpenRouterRecord(input: {
  record: ChatHistorySyncRow;
  generationId: string;
  provider: Exclude<LlmModelProvider, 'openrouter'>;
  log: FastifyBaseLogger;
}): Promise<'settled' | 'not_ready'> {
  const { record, generationId, provider, log } = input;
  const finishReason = record.llm_finish_reason;
  if (typeof finishReason !== 'string') return 'not_ready';

  const model =
    typeof record.llm_billing_snapshot?.provider_model_id === 'string'
      ? record.llm_billing_snapshot.provider_model_id
      : record.model;
  let reconciled: ReconciledChargeResult;
  try {
    reconciled = await reconcileCharge({
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
    await history().recordBillingOutcome({
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

interface ReconciledChargeResult {
  settled: boolean;
  intendedDeduction?: number;
  deductionRate?: number;
}

/**
 * 结算这一行对应的计费记录，单独返回主表金额，保留上游元数据不变。
 *
 * 定档：finish_reason 到齐后走 applyLlmCharge（与 settle 同一套标签）。
 * 无 charge 行时按请求时快照重建；已 charged / free 的行也重入以补额度收口和金额回写。
 * 历史 usage 口径仍走 reconcileLlmUsage。都靠 charge_id 幂等，重复跑不会多扣。
 *
 * 导出给单测：锁死回捞后 success + length 是 incomplete，而不是旧的 complete。
 */
export async function reconcileCharge(input: {
  record: Pick<
    ChatHistorySyncRow,
    | 'id'
    | 'user_id'
    | 'model'
    | 'llm_charge_id'
    | 'assistant_reply'
    | 'status'
    | 'llm_billing_snapshot'
  > & { callProvider?: LlmModelProvider | null };
  generationId: string | null;
  genData: Record<string, unknown>;
  finishReason: string | null;
}): Promise<ReconciledChargeResult> {
  const { record, generationId, genData, finishReason } = input;
  const chargeId = record.llm_charge_id;
  if (typeof chargeId !== 'string' || chargeId.length === 0) return { settled: false };

  const usageCost = genData.usage;
  const snapshot = readBillingSnapshot(
    record.llm_billing_snapshot,
    record.callProvider ?? undefined
  );
  const originalCharge = await wallets().findLlmUsageCharge(chargeId);

  if (originalCharge && originalCharge.metadata?.billing_mode !== 'fixed_tier') {
    if (typeof usageCost === 'number' && Number.isFinite(usageCost) && finishReason === 'stop') {
      const intendedDeduction = calculateUsageDeduction(
        usageCost,
        Number(originalCharge.exchange_rate),
        Number(originalCharge.model_markup)
      );
      const reconciled = await wallets().reconcileLlmUsage({
        chargeId,
        usageCostUsd: usageCost,
        calculatedAmount: intendedDeduction,
        metadata: { source: 'chat_history_sync' },
      });
      return {
        settled: true,
        intendedDeduction,
        deductionRate: Number(reconciled.charge.charged_amount),
      };
    }
    return { settled: false };
  }

  if (finishReason === null) return { settled: false };

  const command = buildFixedTierChargeCommand({
    chargeId,
    generationId,
    record,
    genData,
    finishReason,
    snapshot,
    originalCharge,
    usageCost,
  });
  if (!command) return { settled: false };

  const result = await applyLlmCharge(command);
  return {
    settled: !result.pending,
    intendedDeduction: result.calculatedAmount,
    deductionRate: result.chargedAmount,
  };
}

function buildFixedTierChargeCommand(input: {
  chargeId: string;
  generationId: string | null;
  record: Pick<ChatHistorySyncRow, 'user_id' | 'model' | 'assistant_reply' | 'status'>;
  genData: Record<string, unknown>;
  finishReason: string;
  snapshot: LlmBillingSnapshot | null;
  originalCharge: {
    user_id: string;
    model_id: string | null;
    model_openrouter_id: string;
    model_display_name: string;
    catalog_version: number;
    pricing_config_version: number;
    exchange_rate: unknown;
    model_markup: unknown;
    calculated_amount: unknown;
    metadata: Record<string, unknown> | null;
  } | null;
  usageCost: unknown;
}) {
  const {
    chargeId,
    generationId,
    record,
    genData,
    finishReason,
    snapshot,
    originalCharge,
    usageCost,
  } = input;
  if (!originalCharge && !snapshot) return null;

  const userId = originalCharge?.user_id ?? record.user_id;
  if (typeof userId !== 'string' || userId.length === 0) return null;

  const displayName = (
    snapshot?.model_display_name ??
    originalCharge?.model_display_name ??
    ''
  ).trim();
  if (!displayName) return null;

  const requestedModel = originalCharge?.model_openrouter_id ?? record.model;
  if (typeof requestedModel !== 'string' || requestedModel.trim() === '') return null;

  const fixedDeduction = resolveFixedDeductionAmount(snapshot, originalCharge);
  const observedModel =
    typeof genData.model === 'string' && genData.model.trim() ? genData.model : null;

  return {
    chargeId,
    generationId,
    userId,
    modelId: snapshot?.model_id ?? originalCharge?.model_id ?? null,
    requestedModel,
    observedModel,
    requestedDisplayName: displayName,
    catalogVersion: originalCharge?.catalog_version ?? snapshot?.catalog_version ?? 0,
    pricingConfigVersion:
      originalCharge?.pricing_config_version ?? snapshot?.pricing_config_version ?? 0,
    usageCostUsd: typeof usageCost === 'number' && Number.isFinite(usageCost) ? usageCost : null,
    exchangeRate: Number(originalCharge?.exchange_rate ?? snapshot?.exchange_rate ?? 1),
    modelMarkup: Number(originalCharge?.model_markup ?? snapshot?.model_markup ?? 0),
    calculatedAmount: fixedDeduction,
    fallbackUsed: false,
    generationStatus: record.status,
    finishReason,
    assistantReply: record.assistant_reply,
    baseMetadata: {
      ...(originalCharge?.metadata ?? {}),
      requested_model: requestedModel,
      provider:
        snapshot?.provider ||
        (typeof originalCharge?.metadata?.provider === 'string'
          ? originalCharge.metadata.provider
          : 'openrouter'),
      provider_model_id:
        snapshot?.provider_model_id ||
        (typeof originalCharge?.metadata?.provider_model_id === 'string'
          ? originalCharge.metadata.provider_model_id
          : requestedModel),
      ...frozenLlmChargeMetadata({
        fixed_deduction: fixedDeduction,
        fixed_deduction_category:
          snapshot?.fixed_deduction_category ||
          (typeof originalCharge?.metadata?.fixed_deduction_category === 'string'
            ? originalCharge.metadata.fixed_deduction_category
            : ''),
        original_credits: snapshot?.original_credits,
        discount_rate: snapshot?.discount_rate,
        discounted_exact: snapshot?.discounted_exact,
        payable_credits: snapshot?.payable_credits ?? fixedDeduction,
        wallet_policy: snapshot?.wallet_policy,
        requires_vip: snapshot?.requires_vip,
        vip_active: snapshot?.vip_active,
        vip_valid_until: snapshot?.vip_valid_until,
        model_tier: snapshot?.model_tier,
        vip_discount_config_version: snapshot?.vip_discount_config_version,
      }),
      source: 'chat_history_sync',
    },
  };
}

function resolveFixedDeductionAmount(
  snapshot: LlmBillingSnapshot | null,
  charge: { metadata?: Record<string, unknown> | null; calculated_amount: unknown } | null
): number {
  if (snapshot && Number.isFinite(snapshot.fixed_deduction) && snapshot.fixed_deduction >= 0) {
    return snapshot.fixed_deduction;
  }
  if (!charge) return 0;
  const fromMeta = Number(charge.metadata?.fixed_deduction ?? charge.calculated_amount);
  return Number.isFinite(fromMeta) && fromMeta >= 0 ? fromMeta : 0;
}

function readBillingSnapshot(
  value: unknown,
  provider?: LlmModelProvider
): LlmBillingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.billing_mode !== undefined && row.billing_mode !== 'fixed_tier') return null;

  const modelDisplayName =
    typeof row.model_display_name === 'string' ? row.model_display_name.trim() : '';
  if (!modelDisplayName) return null;

  const fixedDeduction = Number(row.fixed_deduction);
  const catalogVersion = Number(row.catalog_version);
  const pricingConfigVersion = Number(row.pricing_config_version);
  const exchangeRate = Number(row.exchange_rate);
  const modelMarkup = Number(row.model_markup);
  if (!Number.isFinite(fixedDeduction) || fixedDeduction < 0) return null;
  if (!Number.isInteger(catalogVersion) || !Number.isInteger(pricingConfigVersion)) return null;
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return null;
  if (!Number.isFinite(modelMarkup) || modelMarkup < 0) return null;

  return {
    charge_id: typeof row.charge_id === 'string' ? row.charge_id : '',
    model_id: typeof row.model_id === 'string' ? row.model_id : null,
    provider: provider ?? readProviderFromSnapshot(row),
    provider_model_id:
      typeof row.provider_model_id === 'string' && row.provider_model_id.trim()
        ? row.provider_model_id
        : undefined,
    model_display_name: modelDisplayName,
    model_markup: modelMarkup,
    fixed_deduction: fixedDeduction,
    fixed_deduction_category:
      typeof row.fixed_deduction_category === 'string' ? row.fixed_deduction_category : '',
    catalog_version: catalogVersion,
    pricing_config_version: pricingConfigVersion,
    exchange_rate: exchangeRate,
    billing_mode: 'fixed_tier',
    ...readFrozenPriceFields(row),
  };
}

function readProviderFromSnapshot(value: unknown): LlmModelProvider {
  if (!value || typeof value !== 'object') return 'openrouter';
  const row = value as Record<string, unknown>;
  const parsed = LlmModelProviderSchema.safeParse(row.provider);
  return parsed.success ? parsed.data : 'openrouter';
}

function readFrozenPriceFields(
  row: Record<string, unknown>
): Pick<
  LlmBillingSnapshot,
  | 'original_credits'
  | 'discount_rate'
  | 'discounted_exact'
  | 'payable_credits'
  | 'wallet_policy'
  | 'requires_vip'
  | 'vip_active'
  | 'vip_valid_until'
  | 'model_tier'
> {
  const originalCredits = readOptionalNumber(row.original_credits);
  const payableCredits = readOptionalNumber(row.payable_credits);
  const discountedExact = readOptionalNumber(row.discounted_exact);
  const walletPolicy =
    row.wallet_policy === 'main_only' || row.wallet_policy === 'main_then_bonus'
      ? row.wallet_policy
      : undefined;
  return {
    ...(originalCredits === undefined ? {} : { original_credits: originalCredits }),
    ...(row.discount_rate === null || typeof row.discount_rate === 'number'
      ? { discount_rate: row.discount_rate }
      : {}),
    ...(discountedExact === undefined ? {} : { discounted_exact: discountedExact }),
    ...(payableCredits === undefined ? {} : { payable_credits: payableCredits }),
    ...(walletPolicy === undefined ? {} : { wallet_policy: walletPolicy }),
    ...(typeof row.requires_vip === 'boolean' ? { requires_vip: row.requires_vip } : {}),
    ...(typeof row.vip_active === 'boolean' ? { vip_active: row.vip_active } : {}),
    ...(row.vip_valid_until === null || typeof row.vip_valid_until === 'string'
      ? { vip_valid_until: row.vip_valid_until }
      : {}),
    ...(typeof row.model_tier === 'string' ? { model_tier: row.model_tier } : {}),
  };
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
