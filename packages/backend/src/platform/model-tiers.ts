/**
 * backend / platform / model-tiers.ts
 *
 * model → tier / deductionRate 映射表。
 * LLM proxy 根据请求 body.model 查此表决定扣费额度。
 *
 * 动态从 miniapp.runtime_config 读取 llm_model_tiers。
 * provider 固定为 openrouter（R3 决议）。
 */

import { getSupabaseClient } from '../lib/supabase.js';
import type { ModelTierConfig as SharedModelTierConfig } from '@miniapp/shared';

// 扩展 SharedModelTierConfig 以包含后端需要的字段
export interface BackendModelTierConfig extends SharedModelTierConfig {
  // 后端内部使用的字段可以加在这里
}

let cachedTiers: BackendModelTierConfig[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_TIERS: BackendModelTierConfig[] = [
  {
    tier: 'modelA',
    modelName: 'google/gemini-3.1-flash-lite',
    provider: 'openrouter',
    label: 'gemini模型',
    deductionRate: 0,
    isDefault: true,
  },
  {
    tier: 'modelB',
    modelName: 'anthropic/claude-sonnet-4.5',
    provider: 'openrouter',
    label: 'claude模型',
    deductionRate: 0,
  },
];

export async function fetchModelTiers(): Promise<BackendModelTierConfig[]> {
  const now = Date.now();
  if (cachedTiers && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedTiers;
  }

  try {
    const db = getSupabaseClient().schema('miniapp');
    const { data, error } = await db
      .from('runtime_config')
      .select('value')
      .eq('key', 'llm_model_tiers')
      .maybeSingle();

    if (error) {
      console.error('[model-tiers] Failed to fetch llm_model_tiers from runtime_config:', error);
      return cachedTiers || DEFAULT_TIERS;
    }

    if (data?.value && Array.isArray(data.value)) {
      cachedTiers = data.value as BackendModelTierConfig[];
      lastFetchTime = now;
      return cachedTiers;
    }
  } catch (err) {
    console.error('[model-tiers] Error fetching llm_model_tiers:', err);
  }

  return cachedTiers || DEFAULT_TIERS;
}

export async function getModelTier(modelName: string): Promise<BackendModelTierConfig> {
  const tiers = await fetchModelTiers();
  const found = tiers.find((t) => t.modelName === modelName);
  if (found) return found;

  return {
    tier: 'unknown',
    modelName,
    provider: 'openrouter',
    label: 'Unknown Model',
    deductionRate: 0,
  };
}

export async function getAllTiers(): Promise<BackendModelTierConfig[]> {
  return fetchModelTiers();
}

export const OPENROUTER_PROVIDER = 'openrouter';
