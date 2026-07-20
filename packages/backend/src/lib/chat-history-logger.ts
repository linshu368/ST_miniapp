/**
 * backend / lib / chat-history-logger.ts
 *
 * 异步写入 miniapp.chat_history_log，记录每轮 LLM 交互。
 * 所有写入均为 fire-and-forget，失败仅 log 不影响用户请求。
 */

import type { FastifyBaseLogger } from 'fastify';
import { getSupabaseClient } from './supabase.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import {
  calculateFallbackDeduction,
  calculateUsageDeduction,
} from '../features/billing/usage-pricing.js';

export interface ChatHistoryEntry {
  user_id: string;
  model: string;
  charge_id: string;
  model_id: string | null;
  model_display_name: string;
  model_markup: number;
  catalog_version: number;
  pricing_config_version: number;
  exchange_rate: number;
  fallback_cost: number;
  user_input: string;
  assistant_reply: string | null;
  history: unknown[];
  character_id?: string | null;
  preset_id?: string | null;
  status: 'success' | 'upstream_error' | 'stream_interrupted';
  upstream_status?: number | null;
  deduction_rate?: number; // now calculated internally
  generation_id?: string | null;
}

const OPENROUTER_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const wallets = new MiniappWalletRepository();

async function fetchGenerationDataWithRetry(
  generationId: string,
  log: FastifyBaseLogger,
  maxRetries = 3
) {
  if (!OPENROUTER_API_KEY) return null;

  let lastGenData: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 首次请求前主动等待，给 OpenRouter 生成异步统计数据留出时间
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
      });

      if (!res.ok) {
        try {
          const errBody = await res.json();
          lastGenData = errBody?.data || errBody;
        } catch {
          lastGenData = { error: { message: `OpenRouter API returned status ${res.status}` } };
        }
        throw new Error(`OpenRouter API returned status ${res.status}`);
      }

      const data = await res.json();
      const genData = data?.data || data; // OpenRouter usually wraps response in { data: {...} }
      lastGenData = genData;

      if (genData?.error) {
        throw new Error(`Generation metrics error: ${genData.error.message || 'unknown'}`);
      }

      const isComplete =
        genData &&
        typeof genData.usage !== 'undefined' &&
        typeof genData.latency !== 'undefined' &&
        typeof genData.generation_time !== 'undefined' &&
        typeof genData.finish_reason !== 'undefined' &&
        typeof genData.usage_cache !== 'undefined';

      // 如果返回的数据里没有核心指标，说明可能还在处理中，主动抛错触发重试
      if (!isComplete) {
        throw new Error('Generation metrics not complete yet');
      }

      return genData;
    } catch (err) {
      log.warn(
        { err: String(err), generationId, attempt },
        '[chat-history] failed to fetch complete generation data, retrying...'
      );
      if (attempt === maxRetries) {
        log.error(
          { err: String(err), generationId },
          '[chat-history] max retries reached for fetching generation data'
        );
        return lastGenData;
      }
      // Wait before retrying (exponential backoff: 2s, 4s...)
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  return lastGenData;
}

export function saveChatHistory(entry: ChatHistoryEntry, log: FastifyBaseLogger): void {
  void (async () => {
    try {
      let llmMetadata: Record<string, any> = {
        llm_charge_id: entry.charge_id,
        llm_model_markup: entry.model_markup,
      };
      let actualDeduction = 0;

      // 如果有 generation_id，尝试异步获取详细数据
      if (entry.generation_id) {
        try {
          const genData = await fetchGenerationDataWithRetry(entry.generation_id, log);
          if (genData) {
            llmMetadata = {
              ...llmMetadata,
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
              llm_generation_id: entry.generation_id,
              llm_generation_data: genData, // 即使不完整或有error，也如实记录
            };
          } else {
            // 获取失败（如网络异常导致完全无法获取）时，至少把 generation_id 存下来
            llmMetadata = { ...llmMetadata, llm_generation_id: entry.generation_id };
          }
        } catch (fetchErr) {
          log.error(
            { err: String(fetchErr), generationId: entry.generation_id },
            '[chat-history] error during generation data fetch'
          );
          llmMetadata = { ...llmMetadata, llm_generation_id: entry.generation_id };
        }
      }

      // 仅在生成成功时才计算扣费并执行真实扣款
      if (entry.status === 'success') {
        const usageCost = llmMetadata.llm_usage; // OpenRouter的实际花费金额
        const hasActualUsage = typeof usageCost === 'number' && Number.isFinite(usageCost);
        const intendedDeduction = hasActualUsage
          ? calculateUsageDeduction(usageCost, entry.exchange_rate, entry.model_markup)
          : calculateFallbackDeduction(entry.fallback_cost, entry.model_markup);
        llmMetadata.llm_intended_deduction = intendedDeduction;

        try {
          const actualModel =
            typeof llmMetadata.llm_model === 'string' && llmMetadata.llm_model.trim()
              ? llmMetadata.llm_model
              : entry.model;
          const routedToDifferentModel = actualModel !== entry.model;
          const result = await wallets.chargeLlmUsage({
            chargeId: entry.charge_id,
            generationId: entry.generation_id ?? null,
            userId: entry.user_id,
            modelId: entry.model_id,
            modelOpenRouterId: actualModel,
            modelDisplayName: routedToDifferentModel ? actualModel : entry.model_display_name,
            catalogVersion: entry.catalog_version,
            pricingConfigVersion: entry.pricing_config_version,
            usageCostUsd: hasActualUsage ? usageCost : null,
            exchangeRate: entry.exchange_rate,
            modelMarkup: entry.model_markup,
            calculatedAmount: intendedDeduction,
            fallbackUsed: !hasActualUsage,
            metadata: {
              chat_status: entry.status,
              fallback_cost: entry.fallback_cost,
              requested_model: entry.model,
            },
          });
          actualDeduction = Number(result.charge.charged_amount);
          log.info(
            {
              userId: entry.user_id,
              chargeId: entry.charge_id,
              intendedAmount: intendedDeduction,
              chargedAmount: actualDeduction,
            },
            '[chat-history] atomic LLM usage charge recorded'
          );
        } catch (chargeErr) {
          log.error(
            { err: String(chargeErr), userId: entry.user_id, chargeId: entry.charge_id },
            '[chat-history] atomic LLM usage charge failed'
          );
        }
      }

      const supabase = getSupabaseClient();
      const miniappDb = supabase.schema('miniapp' as 'public');
      const { error } = await miniappDb.from('chat_history').insert({
        user_id: entry.user_id,
        model: entry.model,
        user_input: entry.user_input,
        assistant_reply: entry.assistant_reply,
        history: entry.history,
        character_id: entry.character_id ?? null,
        preset_id: entry.preset_id ?? null,
        status: entry.status,
        upstream_status: entry.upstream_status ?? null,
        deduction_rate: actualDeduction,
        ...llmMetadata,
      });

      if (error) {
        log.error(
          { err: error.message, userId: entry.user_id, model: entry.model },
          '[chat-history] insert failed'
        );
      } else {
        log.info({ userId: entry.user_id, model: entry.model }, '[chat-history] saved');
        if (entry.status === 'success') {
          const { error: roundErr } = await miniappDb.rpc('increment_user_total_round', {
            p_user_id: entry.user_id,
            p_delta: 1,
          });
          if (roundErr) {
            log.error(
              { err: roundErr.message, userId: entry.user_id },
              '[chat-history] increment total_round failed'
            );
          }
        }
      }
    } catch (err: unknown) {
      log.error({ err: String(err), userId: entry.user_id }, '[chat-history] unexpected error');
    }
  })();
}
