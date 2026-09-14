/**
 * backend / features / generation / openrouter-metadata.ts
 *
 * OpenRouter 用量统计（`/generation?id=`）的唯一读取与字段映射入口。
 *
 * 这份数据有两个消费方，两边必须用同一套字段名，否则「哪些行算补齐完成」的判据会分叉：
 *   - settle.ts    一轮生成收尾时即时拉一次
 *   - sync-job.ts  30 秒轮询回捞 24h 内没拉全的行
 *
 * 上游是异步统计：生成刚结束时常常还查不到，所以即时拉取前要先等一会儿。
 */

const GENERATION_API_URL = 'https://openrouter.ai/api/v1/generation';

/** 与 upstream.ts 同源的 key，聊天与用量统计打的是同一个账号。 */
const OPENROUTER_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

/** 即时拉取前的等待：生成刚结束时上游统计还没落库，不等必然空手而归。 */
const FIRST_ATTEMPT_DELAY_MS = 1500;

export type GenerationData = Record<string, unknown>;

export function hasOpenRouterKey(): boolean {
  return OPENROUTER_API_KEY.length > 0;
}

/**
 * 判定这份用量统计是否已经齐全。只用于回捞任务的日志计数，不作为任何写入的闸门。
 *
 * 注意别把它和「哪些行需要回捞」混为一谈：后者是 repository 里的 DB 过滤条件，
 * 且刻意不含 usage_cache（OpenRouter 从不返回该字段，算进去会让每一行恒为待补齐）。
 */
export function isCompleteGenerationData(genData: GenerationData | null): boolean {
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

/** 把上游响应映射成 chat_history 的 llm_* 列。两个消费方共用，不要各自再写一份。 */
export function buildGenerationMetadata(genData: GenerationData): Record<string, unknown> {
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

/**
 * 拉一次用量统计。
 *
 * 返回 null = 这次没拿到任何可记录的东西（无 key / 响应不可解析），调用方应当留待下一轮；
 * 返回带 `error` 的对象 = 上游明确报错，如实记录下来，不再重试。
 */
export async function fetchGenerationData(generationId: string): Promise<GenerationData | null> {
  if (!hasOpenRouterKey()) return null;

  try {
    const res = await fetch(`${GENERATION_API_URL}?id=${generationId}`, {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    });

    const body = await res.json().catch(() => null);
    const genData = body?.data ?? body;

    if (genData && typeof genData === 'object') {
      return genData as GenerationData;
    }

    if (!res.ok) {
      return { error: { message: `OpenRouter API returned status ${res.status}` } };
    }

    return null;
  } catch (err) {
    return { error: { message: String(err) } };
  }
}

/**
 * 生成收尾时的即时拉取：先等上游统计落库，拿不全就如实返回手上这份。
 *
 * 拿不全不是错误——回捞任务（sync-job.ts）会在 24h 窗口内继续补，
 * 所以这里绝不抛，只把最后一次结果交出去。
 */
export async function fetchGenerationDataForSettlement(
  generationId: string
): Promise<GenerationData | null> {
  if (!hasOpenRouterKey()) return null;

  await new Promise((resolve) => setTimeout(resolve, FIRST_ATTEMPT_DELAY_MS));

  const genData = await fetchGenerationData(generationId);
  return genData;
}
