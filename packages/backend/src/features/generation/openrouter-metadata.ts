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

/** The provider's field names are also the OpenRouter table's canonical columns. */
export interface OpenRouterGenerationMetadata {
  provider_name: string | null;
  finish_reason: string | null;
  usage: number | null;
  usage_cache: number | null;
  native_tokens_cached: number | null;
  native_tokens_reasoning: number | null;
  native_tokens_completion: number | null;
  native_tokens_prompt: number | null;
  latency: number | null;
  generation_time: number | null;
  model: string | null;
  llm_generation_data: unknown;
}

export function hasOpenRouterKey(): boolean {
  return OPENROUTER_API_KEY.length > 0;
}

/**
 * 判定这份用量统计是否已经齐全。只用于回捞任务的日志计数，不作为任何写入的闸门。
 *
 * 注意别把它和「哪些行需要回捞」混为一谈：后者是 repository 里的 DB 过滤条件，
 * usage_cache 是可选统计，缺失不能使已齐全的调用一直处于待补齐状态。
 */
export function isCompleteGenerationData(genData: GenerationData | null): boolean {
  return (
    !!genData &&
    !genData.error &&
    nonnegativeNumber(genData.usage) !== null &&
    nonnegativeNumber(genData.latency) !== null &&
    nonnegativeNumber(genData.generation_time) !== null &&
    typeof genData.finish_reason === 'string'
  );
}

/** Select bounded provider metadata without renaming the upstream fields. */
export function buildGenerationMetadata(genData: GenerationData): OpenRouterGenerationMetadata {
  return {
    provider_name: typeof genData.provider_name === 'string' ? genData.provider_name : null,
    finish_reason: typeof genData.finish_reason === 'string' ? genData.finish_reason : null,
    usage: nonnegativeNumber(genData.usage),
    usage_cache: nonnegativeNumber(genData.usage_cache),
    native_tokens_cached: tokenCount(genData.native_tokens_cached),
    native_tokens_reasoning: tokenCount(genData.native_tokens_reasoning),
    native_tokens_completion: tokenCount(genData.native_tokens_completion),
    native_tokens_prompt: tokenCount(genData.native_tokens_prompt),
    latency: nonnegativeNumber(genData.latency),
    generation_time: nonnegativeNumber(genData.generation_time),
    model: typeof genData.model === 'string' ? genData.model : null,
    llm_generation_data: safeGenerationData(genData),
  };
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenCount(value: unknown): number | null {
  const count = nonnegativeNumber(value);
  return count !== null && Number.isInteger(count) ? count : null;
}

/** OpenRouter's response is diagnostic evidence, not a second prompt/archive store. */
function safeGenerationData(value: GenerationData): GenerationData {
  const result: GenerationData = {};
  // Unknown response fields and free-form error messages can contain content or credentials.
  for (const key of ['id', 'provider_name', 'finish_reason', 'model'] as const) {
    if (typeof value[key] === 'string') result[key] = value[key].slice(0, 512);
  }
  for (const key of [
    'usage',
    'usage_cache',
    'native_tokens_cached',
    'native_tokens_reasoning',
    'native_tokens_completion',
    'native_tokens_prompt',
    'latency',
    'generation_time',
  ] as const) {
    const number = nonnegativeNumber(value[key]);
    if (number !== null) result[key] = number;
  }
  if (value.error && typeof value.error === 'object') {
    const code = (value.error as Record<string, unknown>).code;
    result.error = typeof code === 'number' && Number.isFinite(code) ? { code } : {};
  }
  return result;
}

/**
 * 拉一次用量统计。
 *
 * 返回 null = 这次没拿到任何可记录的东西（无 key / 响应不可解析），调用方应当留待下一轮；
 * 返回带 `error` 的对象 = 记录本次失败，由有界 24h 回捞窗口继续补齐。
 */
export async function fetchGenerationData(generationId: string): Promise<GenerationData | null> {
  if (!hasOpenRouterKey()) return null;

  try {
    const res = await fetch(`${GENERATION_API_URL}?id=${generationId}`, {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });

    const body = await res.json().catch(() => null);
    const genData = body?.data ?? body;
    if (!res.ok) return { error: { code: res.status } };

    if (genData && typeof genData === 'object') {
      return safeGenerationData(genData as GenerationData);
    }

    return null;
  } catch {
    return { error: {} };
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
