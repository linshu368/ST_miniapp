/**
 * backend / features / generation / sync-job.ts
 *
 * 生成计费的第二条结算路径：进程内 30 秒轮询，回捞 24h 内元数据不全的轮次。
 *
 * 为什么需要它：OpenRouter 的用量统计是异步的，settle.ts 那一次即时拉取经常拿不到
 * finish_reason。没有 finish_reason 就不能判「是否自然收尾」，于是计费挂 pending
 * （见 §finish_reason 计费闸门）。本任务负责把这些 pending 行结算掉。
 *
 * 它和 settle.ts 是同一个行为的两条路径，所以刻意放在同一个模块下：
 * 用量元数据的字段映射共用 openrouter-metadata.ts，chat_history 的写入共用
 * ConversationHistoryRepository，不允许任何一边私开第二套。
 */

import type { FastifyBaseLogger } from 'fastify';
import { calculateUsageDeduction, resolveUsageBillingGate } from '../billing/usage-pricing.js';
import { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { MiniappCharacterFreeQuotaRepository } from '../../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
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
const wallets = new MiniappWalletRepository();
const freeQuotas = new MiniappCharacterFreeQuotaRepository();
let historyRepository: ConversationHistoryRepository | null = null;

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

      try {
        await reconcileCharge({ record, generationId, genData, finishReason, llmMetadata });
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
        await history().applyGenerationMetadata(record.id, llmMetadata);
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
 * 两种口径：`fixed_tier` 的 pending 行等 finish_reason 到齐后按定档结算；
 * 历史 usage 口径的行按实际用量重算。两者都靠 charge_id 幂等，重复跑不会多扣。
 */
async function reconcileCharge(input: {
  record: {
    id: string;
    llm_charge_id: string | null;
    assistant_reply: string | null;
    status: string;
  };
  generationId: string;
  genData: Record<string, unknown>;
  finishReason: string | null;
  llmMetadata: Record<string, unknown>;
}): Promise<void> {
  const { record, generationId, genData, finishReason, llmMetadata } = input;
  const chargeId = record.llm_charge_id;
  if (typeof chargeId !== 'string' || chargeId.length === 0) return;

  const usageCost = genData.usage;
  const originalCharge = await wallets.findLlmUsageCharge(chargeId);
  if (!originalCharge) return;

  if (
    originalCharge.metadata?.billing_mode === 'fixed_tier' &&
    originalCharge.status === 'pending' &&
    finishReason !== null
  ) {
    const replyOutcome =
      typeof record.assistant_reply === 'string' && record.assistant_reply.trim()
        ? record.status === 'success'
          ? 'complete'
          : 'incomplete'
        : 'empty';
    const billingStatus = replyOutcome === 'complete' ? 'success' : 'stream_interrupted';
    await freeQuotas.finalizePending(
      chargeId,
      billingStatus === 'success' && finishReason === 'stop'
    );

    const fixedDeduction = Number(
      originalCharge.metadata?.fixed_deduction ?? originalCharge.calculated_amount
    );
    const actualModel =
      typeof genData.model === 'string' && genData.model.trim()
        ? genData.model
        : originalCharge.model_openrouter_id;
    const reconciled = await wallets.chargeLlmUsage({
      chargeId,
      generationId,
      userId: originalCharge.user_id,
      modelId: originalCharge.model_id,
      modelOpenRouterId: actualModel,
      modelDisplayName:
        actualModel !== originalCharge.model_openrouter_id
          ? actualModel
          : originalCharge.model_display_name,
      catalogVersion: originalCharge.catalog_version,
      pricingConfigVersion: originalCharge.pricing_config_version,
      usageCostUsd: typeof usageCost === 'number' && Number.isFinite(usageCost) ? usageCost : null,
      exchangeRate: Number(originalCharge.exchange_rate),
      modelMarkup: Number(originalCharge.model_markup),
      calculatedAmount: Number.isFinite(fixedDeduction) ? fixedDeduction : 0,
      fallbackUsed: false,
      metadata: {
        ...(originalCharge.metadata ?? {}),
        source: 'chat_history_sync',
        chat_status: billingStatus,
        generation_status: record.status,
        reply_outcome: replyOutcome,
        reply_char_count:
          typeof record.assistant_reply === 'string' ? record.assistant_reply.length : 0,
        finish_reason: finishReason,
        billing_gate: resolveUsageBillingGate({ status: billingStatus, finishReason }),
      },
    });
    llmMetadata.llm_intended_deduction = Number(reconciled.charge.calculated_amount);
    llmMetadata.deduction_rate = Number(reconciled.charge.charged_amount);
    return;
  }

  if (
    originalCharge.metadata?.billing_mode !== 'fixed_tier' &&
    typeof usageCost === 'number' &&
    Number.isFinite(usageCost) &&
    finishReason === 'stop'
  ) {
    const intendedDeduction = calculateUsageDeduction(
      usageCost,
      Number(originalCharge.exchange_rate),
      Number(originalCharge.model_markup)
    );
    const reconciled = await wallets.reconcileLlmUsage({
      chargeId,
      usageCostUsd: usageCost,
      calculatedAmount: intendedDeduction,
      metadata: { source: 'chat_history_sync' },
    });
    llmMetadata.llm_intended_deduction = intendedDeduction;
    llmMetadata.deduction_rate = Number(reconciled.charge.charged_amount);
  }
}
