import { getProviderModelDirectory } from '../../platform/model-provider-directory.js';
import type { VeniceChatHistoryMetadata } from '../../infrastructure/repositories/VeniceChatHistoryRepository.js';

interface VeniceMetadataInput {
  chatHistoryId: string;
  model: string;
  generationId: string | null;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  responseMetadata: Record<string, unknown>;
  latencyMs: number | null;
  generationTimeMs: number;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usd(value: number): number {
  return Number(value.toFixed(12));
}

export async function buildVeniceMetadata(
  input: VeniceMetadataInput
): Promise<VeniceChatHistoryMetadata> {
  const promptTokens = nonNegativeInteger(input.usage?.prompt_tokens);
  const completionTokens = nonNegativeInteger(input.usage?.completion_tokens);
  const promptDetails = record(input.usage?.prompt_tokens_details);
  const completionDetails = record(input.usage?.completion_tokens_details);
  const cachedTokens = nonNegativeInteger(promptDetails?.cached_tokens);
  const reasoningTokens = nonNegativeInteger(completionDetails?.reasoning_tokens);

  let promptPrice: number | null = null;
  let completionPrice: number | null = null;
  try {
    const directory = await getProviderModelDirectory('venice');
    const model = directory.models.find((candidate) => candidate.id === input.model);
    promptPrice = model?.prompt_usd_per_token ?? null;
    completionPrice = model?.completion_usd_per_token ?? null;
  } catch {
    // Token evidence remains useful even when the directory/key is temporarily unavailable.
  }

  const promptCost =
    promptTokens !== null && promptPrice !== null ? usd(promptTokens * promptPrice) : null;
  const completionCost =
    completionTokens !== null && completionPrice !== null
      ? usd(completionTokens * completionPrice)
      : null;
  const totalCost =
    promptCost !== null && completionCost !== null ? usd(promptCost + completionCost) : null;
  const cachedCost =
    cachedTokens !== null && promptPrice !== null ? usd(cachedTokens * promptPrice) : null;

  return {
    chat_history_id: input.chatHistoryId,
    llm_provider_name: 'venice',
    llm_finish_reason: input.finishReason,
    llm_usage: totalCost,
    llm_usage_cache: cachedCost,
    llm_native_tokens_cached: cachedTokens,
    llm_native_tokens_reasoning: reasoningTokens,
    llm_native_tokens_completion: completionTokens,
    llm_native_tokens_prompt: promptTokens,
    llm_latency: input.latencyMs,
    llm_generation_time: input.generationTimeMs,
    llm_model: input.model,
    llm_generation_id: input.generationId,
    llm_generation_data: {
      ...input.responseMetadata,
      finish_reason: input.finishReason,
      usage: input.usage,
      pricing: {
        prompt_usd_per_token: promptPrice,
        completion_usd_per_token: completionPrice,
        prompt_cost_usd: promptCost,
        completion_cost_usd: completionCost,
        cached_cost_usd: cachedCost,
        total_cost_usd: totalCost,
      },
    },
  };
}
