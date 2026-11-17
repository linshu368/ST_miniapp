import { z } from 'zod';

export const LlmModelProviderSchema = z.enum(['openrouter', 'venice', 'surplus']);
export type LlmModelProvider = z.infer<typeof LlmModelProviderSchema>;

export const LLM_MODEL_PROVIDER_LABELS: Record<LlmModelProvider, string> = {
  openrouter: 'OpenRouter',
  venice: 'Venice',
  surplus: 'Surplus Intelligence',
};

export interface LlmProviderCapability {
  id: LlmModelProvider;
  label: string;
  defaultBaseUrl: string;
  apiKeyEnv: string;
  baseUrlEnv?: string;
  chatCompletionsPath: '/chat/completions';
  modelsPath: '/models';
  supportsOpenRouterProviderRouting: boolean;
  supportsOpenRouterGenerationMetadata: boolean;
  promptCachingMode: 'openrouter_anthropic_cache_control' | 'venice_prompt_cache_key' | 'none';
}

export const LLM_PROVIDER_CAPABILITIES: Record<LlmModelProvider, LlmProviderCapability> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'LLM_API_KEY',
    baseUrlEnv: 'LLM_UPSTREAM_URL',
    chatCompletionsPath: '/chat/completions',
    modelsPath: '/models',
    supportsOpenRouterProviderRouting: true,
    supportsOpenRouterGenerationMetadata: true,
    promptCachingMode: 'openrouter_anthropic_cache_control',
  },
  venice: {
    id: 'venice',
    label: 'Venice',
    defaultBaseUrl: 'https://api.venice.ai/api/v1',
    apiKeyEnv: 'VENICE_API_KEY',
    baseUrlEnv: 'VENICE_API_BASE_URL',
    chatCompletionsPath: '/chat/completions',
    modelsPath: '/models',
    supportsOpenRouterProviderRouting: false,
    supportsOpenRouterGenerationMetadata: false,
    promptCachingMode: 'venice_prompt_cache_key',
  },
  surplus: {
    id: 'surplus',
    label: 'Surplus Intelligence',
    defaultBaseUrl: 'https://api.surplusintelligence.ai/v1',
    apiKeyEnv: 'SURPLUS_API_KEY',
    baseUrlEnv: 'SURPLUS_API_BASE_URL',
    chatCompletionsPath: '/chat/completions',
    modelsPath: '/models',
    supportsOpenRouterProviderRouting: false,
    supportsOpenRouterGenerationMetadata: false,
    promptCachingMode: 'none',
  },
};

export const LLM_MODEL_PROVIDERS = Object.keys(LLM_PROVIDER_CAPABILITIES) as LlmModelProvider[];
