/**
 * backend / lib / chat-history-logger.ts
 *
 * 异步写入 miniapp.chat_history_log，记录每轮 LLM 交互。
 * 所有写入均为 fire-and-forget，失败仅 log 不影响用户请求。
 */

import type { FastifyBaseLogger } from 'fastify';
import { getSupabaseClient } from './supabase.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import { getPricingConfig } from '../platform/model-tiers.js';

export interface ChatHistoryEntry {
  user_id: string;
  model: string;
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
      let llmMetadata: Record<string, any> = {};
      let actualDeduction = 0;

      // 如果有 generation_id，尝试异步获取详细数据
      if (entry.generation_id) {
        try {
          const genData = await fetchGenerationDataWithRetry(entry.generation_id, log);
          if (genData) {
            llmMetadata = {
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
            llmMetadata = { llm_generation_id: entry.generation_id };
          }
        } catch (fetchErr) {
          log.error(
            { err: String(fetchErr), generationId: entry.generation_id },
            '[chat-history] error during generation data fetch'
          );
          llmMetadata = { llm_generation_id: entry.generation_id };
        }
      }

      // 仅在生成成功时才计算扣费并执行真实扣款
      if (entry.status === 'success') {
        const pricing = await getPricingConfig();
        const usageCost = llmMetadata.llm_usage; // OpenRouter的实际花费金额

        if (typeof usageCost === 'number') {
          actualDeduction = Math.round(usageCost * pricing.exchangeRate * pricing.markup);
        } else {
          // 如果本次调用成功了，但获取不到usage，使用兜底额
          actualDeduction = pricing.fallbackCost;
        }

        if (actualDeduction > 0) {
          const intendedDeduction = actualDeduction;
          try {
            await wallets.deduct(entry.user_id, actualDeduction);
            log.info(
              { userId: entry.user_id, amount: actualDeduction },
              '[chat-history] dynamic deduction success'
            );
          } catch (deductErr: any) {
            const errStr = String(deductErr);
            if (errStr.includes('insufficient credits')) {
              // 触发熔断：扣光所有余额
              try {
                const wallet = await wallets.getOrCreate(entry.user_id);
                const remaining =
                  wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
                if (remaining > 0) {
                  await wallets.deduct(entry.user_id, remaining);
                  log.warn(
                    { userId: entry.user_id, intendedDeduction, drainedAmount: remaining },
                    '[chat-history] insufficient credits, drained remaining balance'
                  );
                  actualDeduction = remaining; // 更新为实际扣除的金额
                } else {
                  log.warn(
                    { userId: entry.user_id, intendedDeduction },
                    '[chat-history] insufficient credits, balance is already 0'
                  );
                  actualDeduction = 0;
                }
                // 在 metadata 中记录原本应该扣除的金额，便于后续对账和风控分析
                llmMetadata.llm_intended_deduction = intendedDeduction;
              } catch (drainErr) {
                log.error(
                  { err: String(drainErr), userId: entry.user_id },
                  '[chat-history] failed to drain balance'
                );
                actualDeduction = 0;
              }
            } else {
              log.error(
                { err: errStr, userId: entry.user_id, amount: actualDeduction },
                '[chat-history] dynamic deduction failed'
              );
              actualDeduction = 0;
            }
          }
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
