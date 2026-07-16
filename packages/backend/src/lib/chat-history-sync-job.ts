import type { FastifyBaseLogger } from 'fastify';
import { getSupabaseClient } from './supabase.js';

const OPENROUTER_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

let timerId: NodeJS.Timeout | null = null;

export function startChatHistorySyncJob(log: FastifyBaseLogger) {
  if (!OPENROUTER_API_KEY) {
    log.warn('[sync-job] missing API key, skipping chat history sync job');
    return;
  }

  // 10 minutes interval
  const interval = 10 * 60 * 1000;

  timerId = setInterval(() => {
    void runSyncJob(log);
  }, interval);

  // 启动后 10 秒尝试运行一次
  setTimeout(() => {
    void runSyncJob(log);
  }, 10 * 1000);

  log.info('[sync-job] Chat history sync job started');
}

export function stopChatHistorySyncJob() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

async function runSyncJob(log: FastifyBaseLogger) {
  try {
    const supabase = getSupabaseClient();
    const miniappDb = supabase.schema('miniapp' as 'public');

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 查找最近24小时内，有 generation_id，且这5个核心字段中有任意一个为 null 的记录
    const { data, error } = await miniappDb
      .from('chat_history')
      .select('id, generation_id')
      .not('generation_id', 'is', null)
      .gte('created_at', oneDayAgo)
      .or(
        'llm_usage.is.null,llm_latency.is.null,llm_generation_time.is.null,llm_finish_reason.is.null,llm_usage_cache.is.null'
      );

    if (error) {
      log.error({ err: error.message }, '[sync-job] failed to fetch incomplete chat history');
      return;
    }

    if (!data || data.length === 0) {
      return;
    }

    log.info(`[sync-job] found ${data.length} incomplete records to sync`);

    for (const record of data) {
      if (!record.generation_id) continue;

      const genData = await fetchSingle(record.generation_id);
      if (!genData || genData.error) {
        continue;
      }

      const isComplete =
        typeof genData.usage !== 'undefined' &&
        typeof genData.latency !== 'undefined' &&
        typeof genData.generation_time !== 'undefined' &&
        typeof genData.finish_reason !== 'undefined' &&
        typeof genData.usage_cache !== 'undefined';

      if (isComplete) {
        const llmMetadata = {
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

        const { error: updateErr } = await miniappDb
          .from('chat_history')
          .update(llmMetadata)
          .eq('id', record.id);

        if (updateErr) {
          log.error(
            { err: updateErr.message, id: record.id },
            '[sync-job] failed to update chat history'
          );
        } else {
          log.info(
            { id: record.id, generationId: record.generation_id },
            '[sync-job] successfully synced generation data'
          );
        }
      }
    }
  } catch (err) {
    log.error({ err: String(err) }, '[sync-job] unexpected error');
  }
}

async function fetchSingle(generationId: string) {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return data?.data || data;
  } catch {
    return null;
  }
}
