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
import type { ChatHistorySyncRow } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { observeBackgroundRun } from '../../lib/background-observability.js';
import { hasOpenRouterKey, isCompleteGenerationData } from './openrouter-metadata.js';
import {
  processSyncRecord,
  syncHistory,
  syncOpenRouterHistory,
  type SyncRecordOutcome,
} from './sync-record-recovery.js';
import {
  runSettledWithConcurrency,
  pruneRetryStates,
  registerRetryState,
  shouldDeferRecord,
  syncRetryStates,
} from './sync-retry-state.js';
import {
  recoverSurplusRequestMetadata,
  type SurplusMetadataRecoveryResult,
} from './surplus-request-recovery.js';

export { reconcileCharge } from './sync-charge-recovery.js';

const SYNC_INTERVAL_MS = 30_000;
const STARTUP_DELAY_MS = 5_000;
const LOOKBACK_HOURS = 24;
const BATCH_LIMIT = 50;
const SCAN_CONCURRENCY = 2;
const RECORD_CONCURRENCY = 3;
const PROVIDER_FETCH_BUDGET = 9;
let timerId: NodeJS.Timeout | null = null;
let startupTimerId: NodeJS.Timeout | null = null;
let isRunning = false;

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
  syncRetryStates.clear();
}

async function scanSyncRows(
  input: { since: string; limit: number },
  log: FastifyBaseLogger
): Promise<{ rows: ChatHistorySyncRow[]; partial: boolean }> {
  const sources = [
    'openrouter_billing',
    'venice_billing',
    'surplus_billing',
    'missing_identity',
    'metadata',
    'stale_streaming',
  ];
  const scans = await runSettledWithConcurrency(
    [
      () => syncHistory().listRowsPendingBilling({ ...input, provider: 'openrouter' }),
      () => syncHistory().listRowsPendingBilling({ ...input, provider: 'venice' }),
      () => syncHistory().listRowsPendingBilling({ ...input, provider: 'surplus' }),
      () => syncHistory().listRowsMissingProviderIdentity(input),
      () => syncOpenRouterHistory().listRowsMissingGenerationData(input),
      () => syncHistory().listStaleStreaming(input),
    ],
    SCAN_CONCURRENCY
  );
  const rowsById = new Map<string, ChatHistorySyncRow>();
  let partial = false;
  for (const [index, scan] of scans.entries()) {
    if (scan.status === 'rejected') {
      partial = true;
      log.error(
        {
          kind: 'sys',
          event: 'chathistory_sync.fetch_failed',
          err: scan.reason,
          source: sources[index],
        },
        'failed to fetch incomplete chat history'
      );
      continue;
    }
    for (const row of scan.value) {
      const previous = rowsById.get(row.id);
      if (!previous || (row.llm_billing_settled_at && !previous.llm_billing_settled_at))
        rowsById.set(row.id, row);
    }
  }
  return { rows: [...rowsById.values()], partial };
}

type SyncCounts = Record<SyncRecordOutcome, number>;
interface BillingBatch {
  counts: SyncCounts;
  eligibleCount: number;
  deferredCount: number;
  remainingProviderFetches: number;
}

async function readStoredMetadata(rows: ChatHistorySyncRow[], log: FastifyBaseLogger) {
  const ids = rows
    .filter(
      (row) => row.status !== 'streaming' && row.callProvider === 'openrouter' && !!row.generationId
    )
    .map((row) => row.id);
  try {
    return {
      data:
        ids.length > 0
          ? await syncOpenRouterHistory().readGenerationDataBatch(ids)
          : new Map<string, Record<string, unknown>>(),
      failed: false,
    };
  } catch (err) {
    log.error(
      { kind: 'sys', event: 'chathistory_sync.metadata_batch_read_failed', err },
      'failed to batch-read OpenRouter generation metadata'
    );
    return { data: new Map<string, Record<string, unknown>>(), failed: true };
  }
}

async function runBillingBatch(
  rows: ChatHistorySyncRow[],
  log: FastifyBaseLogger
): Promise<BillingBatch> {
  const now = Date.now();
  pruneRetryStates(now);
  const eligibleRows = rows.filter(
    (row) => row.status === 'streaming' || !shouldDeferRecord(row, now)
  );
  const stored = await readStoredMetadata(eligibleRows, log);
  let remainingProviderFetches = PROVIDER_FETCH_BUDGET;
  const results = await runSettledWithConcurrency(
    eligibleRows.map((record) => async () => {
      if (
        stored.failed &&
        record.status !== 'streaming' &&
        record.callProvider === 'openrouter' &&
        !!record.generationId
      )
        return 'failed' as const;
      const requiresFetch =
        record.callProvider === 'openrouter' &&
        !!record.generationId &&
        hasOpenRouterKey() &&
        !isCompleteGenerationData(stored.data.get(record.id) ?? null);
      const allowProviderFetch = !requiresFetch || remainingProviderFetches > 0;
      if (requiresFetch && allowProviderFetch) remainingProviderFetches--;
      return processSyncRecord({
        record,
        storedGenerationData: stored.data,
        allowProviderFetch,
        log,
      });
    }),
    RECORD_CONCURRENCY
  );
  return {
    counts: summarizeResults(eligibleRows, results, log),
    eligibleCount: eligibleRows.length,
    deferredCount: rows.length - eligibleRows.length,
    remainingProviderFetches,
  };
}

function summarizeResults(
  rows: ChatHistorySyncRow[],
  results: Array<PromiseSettledResult<SyncRecordOutcome>>,
  log: FastifyBaseLogger
): SyncCounts {
  const counts: SyncCounts = {
    completed: 0,
    error_data: 0,
    not_ready: 0,
    recovered: 0,
    manual_audit: 0,
    budget_deferred: 0,
    failed: 0,
  };
  for (const [index, result] of results.entries()) {
    const record = rows[index];
    if (!record) continue;
    if (result.status === 'rejected') {
      counts.failed++;
      registerRetryState(record, Date.now());
      log.error(
        { err: result.reason, event: 'chathistory_sync.record_failed', id: record.id },
        'record deferred; remaining candidates continue'
      );
      continue;
    }
    counts[result.value]++;
    if (['not_ready', 'error_data', 'manual_audit', 'failed'].includes(result.value))
      registerRetryState(record, Date.now());
    else syncRetryStates.delete(record.id);
  }
  return counts;
}

async function runSurplusMetadata(
  log: FastifyBaseLogger,
  requestBudget: number
): Promise<SurplusMetadataRecoveryResult | null> {
  try {
    return await recoverSurplusRequestMetadata({ log, requestBudget });
  } catch (err) {
    log.error(
      { kind: 'sys', event: 'chathistory_sync.surplus_metadata_failed', err },
      'Surplus metadata scan failed; billing recovery remains independent'
    );
    return null;
  }
}

function logSummary(input: {
  log: FastifyBaseLogger;
  rows: number;
  batch: BillingBatch;
  metadata: SurplusMetadataRecoveryResult | null;
  startedAt: number;
}) {
  const { log, rows, batch, metadata, startedAt } = input;
  log.info(
    {
      kind: 'sys',
      event: 'chathistory_sync.finished',
      scannedCount: rows,
      eligibleCount: batch.eligibleCount,
      deferredCount: batch.deferredCount,
      completedCount: batch.counts.completed,
      recoveredCount: batch.counts.recovered,
      errorDataCount: batch.counts.error_data,
      notReadyCount: batch.counts.not_ready,
      manualAuditCount: batch.counts.manual_audit,
      providerBudgetDeferredCount: batch.counts.budget_deferred,
      failedCount: batch.counts.failed,
      retryStateSize: syncRetryStates.size,
      surplusMetadataClaimedCount: metadata?.claimed ?? 0,
      surplusMetadataCompletedCount: metadata?.completed ?? 0,
      surplusMetadataFailedCount: metadata?.failed ?? 0,
      durationMs: Date.now() - startedAt,
    },
    '[sync-job] sync run finished'
  );
}

async function runSyncJob(log: FastifyBaseLogger): Promise<void> {
  const observationStartedAt = performance.now();
  if (isRunning) {
    log.info('[sync-job] previous run is still active, skipping this tick');
    observeBackgroundRun({
      job: 'chat_history_sync',
      outcome: 'skipped',
      startedAt: observationStartedAt,
    });
    return;
  }
  isRunning = true;
  const startedAt = Date.now();
  let outcome: 'success' | 'partial' | 'error' | 'skipped' = 'success';
  let terminalError: unknown;
  try {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const scanned = await scanSyncRows({ since, limit: BATCH_LIMIT }, log);
    const batch = await runBillingBatch(scanned.rows, log);
    // Even with no pending bill, an already-settled Surplus call may lack provider facts.
    // Both provider readers share the same round budget; metadata never consumes a billing slot.
    const metadata = await runSurplusMetadata(log, batch.remainingProviderFetches);
    if (scanned.partial || batch.counts.failed > 0 || metadata === null || metadata.failed > 0)
      outcome = 'partial';
    else if (scanned.rows.length === 0 && metadata.claimed === 0) outcome = 'skipped';
    logSummary({ log, rows: scanned.rows.length, batch, metadata, startedAt });
  } catch (err) {
    outcome = 'error';
    terminalError = err;
    log.error({ kind: 'sys', event: 'chathistory_sync.unexpected', err }, 'unexpected error');
  } finally {
    observeBackgroundRun({
      job: 'chat_history_sync',
      outcome,
      startedAt: observationStartedAt,
      error: terminalError,
    });
    isRunning = false;
  }
}
