import type { FastifyBaseLogger } from 'fastify';
import { getSupabaseClient } from './supabase.js';
import {
  calculateUsageDeduction,
  resolveUsageBillingGate,
} from '../features/billing/usage-pricing.js';
import { MiniappCharacterFreeQuotaRepository } from '../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';

const OPENROUTER_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const SYNC_INTERVAL_MS = 30 * 1000;
const STARTUP_DELAY_MS = 5 * 1000;
const LOOKBACK_HOURS = 24;
const BATCH_LIMIT = 50;

let timerId: NodeJS.Timeout | null = null;
let startupTimerId: NodeJS.Timeout | null = null;
let isRunning = false;
const wallets = new MiniappWalletRepository();
const freeQuotas = new MiniappCharacterFreeQuotaRepository();

function isCompleteGenerationData(genData: Record<string, unknown> | null): boolean {
  return (
    !!genData &&
    !genData.error &&
    typeof genData.usage !== 'undefined' &&
    typeof genData.latency !== 'undefined' &&
    typeof genData.generation_time !== 'undefined' &&
    typeof genData.finish_reason !== 'undefined' &&
    typeof genData.usage_cache !== 'undefined'
  );
}

export function startChatHistorySyncJob(log: FastifyBaseLogger): void {
  if (timerId || startupTimerId) return;

  const jlog = log.child({ module: 'chat-history-sync' });

  if (!OPENROUTER_API_KEY) {
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
    const supabase = getSupabaseClient();
    const miniappDb = supabase.schema('miniapp' as 'public');
    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

    const { data, error } = await miniappDb
      .from('chat_history')
      .select('id, llm_generation_id, llm_charge_id, assistant_reply, status')
      .not('llm_generation_id', 'is', null)
      .gte('created_at', since)
      // llm_usage_cache 不参与判定：OpenRouter 从不返回 usage_cache，把它算进来会让窗口内
      // 每一行都恒为「不完整」，被反复重新拉取直到滚出 24h。
      .or(
        'llm_generation_data.is.null,llm_usage.is.null,llm_latency.is.null,llm_generation_time.is.null,llm_finish_reason.is.null'
      )
      .order('created_at', { ascending: false })
      .limit(BATCH_LIMIT);

    if (error) {
      log.error(
        { kind: 'sys', event: 'chathistory_sync.fetch_failed', err: error },
        'failed to fetch incomplete chat history'
      );
      return;
    }

    if (!data || data.length === 0) {
      log.info('[sync-job] no incomplete chat history records found');
      return;
    }

    let completedCount = 0;
    let errorDataCount = 0;
    let notReadyCount = 0;
    log.info({ count: data.length }, '[sync-job] found incomplete records to sync');

    for (const record of data) {
      const generationId = record.llm_generation_id;
      if (typeof generationId !== 'string' || generationId.length === 0) continue;

      const genData = await fetchSingleGenerationData(generationId);
      if (!genData) {
        notReadyCount++;
        continue;
      }

      const isComplete = isCompleteGenerationData(genData);
      const llmMetadata = buildGenerationMetadata(genData);
      const usageCost = genData.usage;
      const finishReason = typeof genData.finish_reason === 'string' ? genData.finish_reason : null;
      const chargeId = record.llm_charge_id;
      let reconciliationFailed = false;

      if (typeof chargeId === 'string' && chargeId.length > 0) {
        try {
          const originalCharge = await wallets.findLlmUsageCharge(chargeId);
          if (
            originalCharge?.metadata?.billing_mode === 'fixed_tier' &&
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
              generationId: generationId,
              userId: originalCharge.user_id,
              modelId: originalCharge.model_id,
              modelOpenRouterId: actualModel,
              modelDisplayName:
                actualModel !== originalCharge.model_openrouter_id
                  ? actualModel
                  : originalCharge.model_display_name,
              catalogVersion: originalCharge.catalog_version,
              pricingConfigVersion: originalCharge.pricing_config_version,
              usageCostUsd:
                typeof usageCost === 'number' && Number.isFinite(usageCost) ? usageCost : null,
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
                billing_gate: resolveUsageBillingGate({
                  status: billingStatus,
                  finishReason,
                }),
              },
            });
            llmMetadata.llm_intended_deduction = Number(reconciled.charge.calculated_amount);
            llmMetadata.deduction_rate = Number(reconciled.charge.charged_amount);
          } else if (
            originalCharge &&
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
        } catch (reconcileErr) {
          reconciliationFailed = true;
          log.error(
            {
              kind: 'sys',
              event: 'chathistory_sync.reconcile_failed',
              err: reconcileErr,
              id: record.id,
              generationId,
              chargeId,
            },
            'failed to reconcile LLM usage charge'
          );
        }
      }

      // 保留缺失的 generation 字段，让下一轮同步继续重试计费与免费额度终结。
      if (reconciliationFailed) continue;

      const { error: updateErr } = await miniappDb
        .from('chat_history')
        .update(llmMetadata)
        .eq('id', record.id);

      if (updateErr) {
        log.error(
          {
            kind: 'sys',
            event: 'chathistory_sync.update_failed',
            err: updateErr,
            id: record.id,
            generationId,
          },
          'failed to update chat history'
        );
        continue;
      }

      if (isComplete) {
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
      { scannedCount: data.length, completedCount, errorDataCount, notReadyCount },
      '[sync-job] sync run finished'
    );
  } catch (err) {
    log.error({ kind: 'sys', event: 'chathistory_sync.unexpected', err }, 'unexpected error');
  } finally {
    isRunning = false;
  }
}

function buildGenerationMetadata(genData: Record<string, unknown>): Record<string, unknown> {
  return {
    llm_provider_name: genData.provider_name ?? null,
    llm_finish_reason: genData.finish_reason ?? null,
    llm_usage: genData.usage ?? null,
    llm_usage_cache: genData.usage_cache ?? null,
    llm_native_tokens_cached: genData.native_tokens_cached ?? null,
    llm_native_tokens_reasoning: genData.native_tokens_reasoning ?? null,
    llm_native_tokens_completion: genData.native_tokens_completion ?? null,
    llm_native_tokens_prompt: genData.native_tokens_prompt ?? null,
    llm_latency: genData.latency ?? null,
    llm_generation_time: genData.generation_time ?? null,
    llm_model: genData.model ?? null,
    llm_generation_data: genData,
  };
}

async function fetchSingleGenerationData(
  generationId: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
    });

    const data = await res.json().catch(() => null);
    const genData = data?.data || data;

    if (genData && typeof genData === 'object') {
      return genData as Record<string, unknown>;
    }

    if (!res.ok) {
      return {
        error: {
          message: `OpenRouter API returned status ${res.status}`,
        },
      };
    }

    return null;
  } catch (err) {
    return {
      error: {
        message: String(err),
      },
    };
  }
}
