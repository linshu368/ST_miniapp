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
import { calculateUsageDeduction } from '../billing/usage-pricing.js';
import {
  ConversationHistoryRepository,
  type ChatHistorySyncRow,
  type LlmBillingSnapshot,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import { applyLlmCharge } from './apply-charge.js';
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

let timerId: NodeJS.Timeout | null = null;
let startupTimerId: NodeJS.Timeout | null = null;
let isRunning = false;
let walletRepository: MiniappWalletRepository | null = null;
let historyRepository: ConversationHistoryRepository | null = null;

function wallets(): MiniappWalletRepository {
  return (walletRepository ??= new MiniappWalletRepository());
}

function history(): ConversationHistoryRepository {
  return (historyRepository ??= new ConversationHistoryRepository());
}

export function startChatHistorySyncJob(log: FastifyBaseLogger): void {
  if (timerId || startupTimerId) return;

  const jlog = log.child({ module: 'chat-history-sync' });

  if (!hasOpenRouterKey()) {
    jlog.warn(
      { kind: 'sys', event: 'chathistory_sync.disabled' },
      'missing API key, skipping chat history sync job'
    );
    return;
  }

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
}

async function runSyncJob(log: FastifyBaseLogger): Promise<void> {
  if (isRunning) {
    log.info('[sync-job] previous run is still active, skipping this tick');
    return;
  }

  isRunning = true;

  try {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

    let rows;
    try {
      rows = await history().listRowsMissingGenerationData({ since, limit: BATCH_LIMIT });
    } catch (err) {
      log.error(
        { kind: 'sys', event: 'chathistory_sync.fetch_failed', err },
        'failed to fetch incomplete chat history'
      );
      return;
    }

    if (rows.length === 0) {
      log.info('[sync-job] no incomplete chat history records found');
      return;
    }

    let completedCount = 0;
    let errorDataCount = 0;
    let notReadyCount = 0;
    log.info({ count: rows.length }, '[sync-job] found incomplete records to sync');

    for (const record of rows) {
      const generationId = record.llm_generation_id;
      if (typeof generationId !== 'string' || generationId.length === 0) continue;

      const genData = await fetchGenerationData(generationId);
      if (!genData) {
        notReadyCount++;
        continue;
      }

      const llmMetadata = buildGenerationMetadata(genData);
      const finishReason = typeof genData.finish_reason === 'string' ? genData.finish_reason : null;

      let settled = false;
      try {
        const reconciled = await reconcileCharge({
          record,
          generationId,
          genData,
          finishReason,
          llmMetadata,
        });
        settled = reconciled.settled;
      } catch (reconcileErr) {
        // 保留缺失的 generation 字段，让下一轮同步继续重试计费与免费额度终结。
        log.error(
          {
            kind: 'sys',
            event: 'chathistory_sync.reconcile_failed',
            err: reconcileErr,
            id: record.id,
            generationId,
            chargeId: record.llm_charge_id,
          },
          'failed to reconcile LLM usage charge'
        );
        continue;
      }

      try {
        await history().applyGenerationMetadata(
          record.id,
          llmMetadata,
          settled ? new Date().toISOString() : undefined
        );
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
        continue;
      }

      if (isCompleteGenerationData(genData)) {
        completedCount++;
        log.info({ id: record.id, generationId }, '[sync-job] successfully synced generation data');
      } else if (genData.error) {
        errorDataCount++;
        log.info({ id: record.id, generationId }, '[sync-job] saved generation error data');
      } else {
        notReadyCount++;
        log.info({ id: record.id, generationId }, '[sync-job] saved incomplete generation data');
      }
    }

    log.info(
      { scannedCount: rows.length, completedCount, errorDataCount, notReadyCount },
      '[sync-job] sync run finished'
    );
  } catch (err) {
    log.error({ kind: 'sys', event: 'chathistory_sync.unexpected', err }, 'unexpected error');
  } finally {
    isRunning = false;
  }
}

/**
 * 结算这一行对应的计费记录，并把结算金额并进要回写的元数据。
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
  >;
  generationId: string;
  genData: Record<string, unknown>;
  finishReason: string | null;
  llmMetadata: Record<string, unknown>;
}): Promise<{ settled: boolean }> {
  const { record, generationId, genData, finishReason, llmMetadata } = input;
  const chargeId = record.llm_charge_id;
  if (typeof chargeId !== 'string' || chargeId.length === 0) return { settled: false };

  const usageCost = genData.usage;
  const snapshot = readBillingSnapshot(record.llm_billing_snapshot);
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
      llmMetadata.llm_intended_deduction = intendedDeduction;
      llmMetadata.deduction_rate = Number(reconciled.charge.charged_amount);
      return { settled: true };
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
  llmMetadata.llm_intended_deduction = result.calculatedAmount;
  llmMetadata.deduction_rate = result.chargedAmount;
  return { settled: true };
}

function buildFixedTierChargeCommand(input: {
  chargeId: string;
  generationId: string;
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
    originalCharge?.model_display_name ??
    snapshot?.model_display_name ??
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
    modelId: originalCharge?.model_id ?? snapshot?.model_id ?? null,
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
      billing_mode: 'fixed_tier' as const,
      fixed_deduction_category:
        snapshot?.fixed_deduction_category ?? originalCharge?.metadata?.fixed_deduction_category,
      fixed_deduction: fixedDeduction,
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

function readBillingSnapshot(value: unknown): LlmBillingSnapshot | null {
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
    model_display_name: modelDisplayName,
    model_markup: modelMarkup,
    fixed_deduction: fixedDeduction,
    fixed_deduction_category:
      typeof row.fixed_deduction_category === 'string' ? row.fixed_deduction_category : '',
    catalog_version: catalogVersion,
    pricing_config_version: pricingConfigVersion,
    exchange_rate: exchangeRate,
    billing_mode: 'fixed_tier',
  };
}
