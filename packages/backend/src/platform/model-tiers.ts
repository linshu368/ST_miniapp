/**
 * backend / platform / model-tiers.ts
 *
 * model → tier / deductionRate 映射表。
 * LLM proxy 根据请求 body.model 查此表决定扣费额度。
 *
 * MVP 硬编码；后续可迁入 miniapp.runtime_config 做运营热更。
 * provider 固定为 openrouter（R3 决议）。
 */

export interface ModelTierConfig {
  tier: 'standard' | 'premium';
  deductionRate: number;
  displayName: string;
}

const MODEL_TIER_MAP: Record<string, ModelTierConfig> = {
  'google/gemini-2.5-flash': {
    tier: 'standard',
    deductionRate: 0,
    displayName: 'Gemini 2.5 Flash',
  },
  'anthropic/claude-sonnet-4': {
    tier: 'premium',
    deductionRate: 0,
    displayName: 'Claude Sonnet 4',
  },
};

const DEFAULT_TIER: ModelTierConfig = {
  tier: 'standard',
  deductionRate: 0,
  displayName: 'Unknown Model',
};

export function getModelTier(modelName: string): ModelTierConfig {
  return MODEL_TIER_MAP[modelName] ?? DEFAULT_TIER;
}

export function getAllTiers(): Array<{ modelName: string } & ModelTierConfig> {
  return Object.entries(MODEL_TIER_MAP).map(([modelName, config]) => ({
    modelName,
    ...config,
  }));
}

export const OPENROUTER_PROVIDER = 'openrouter';
