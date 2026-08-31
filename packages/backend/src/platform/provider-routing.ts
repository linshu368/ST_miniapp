/**
 * backend / platform / provider-routing.ts
 *
 * 「模型 × 供应商」路由配置（llm_provider_routing_config）的读取与缓存。
 *
 * 缓存口径与 model-tiers.ts 一致：按 runtime_config.version 判活，另有 5 分钟 TTL
 * 兜底 key 不存在的场景。任何读取 / 解析失败都静默降级为空配置——供应商路由是
 * 软干预，绝不能因为配置问题阻断对话生成。
 */

import {
  DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  LLM_PROVIDER_ROUTING_CONFIG_KEY,
  LlmProviderRoutingConfigSchema,
  resolveProviderPreferences,
  type LlmProviderRoutingConfig,
  type OpenRouterProviderPreferences,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntry } from './runtime-config.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedConfig: LlmProviderRoutingConfig | null = null;
let cachedVersion = 0;
let lastFetchTime = 0;

export async function getProviderRoutingConfig(): Promise<LlmProviderRoutingConfig> {
  const now = Date.now();

  try {
    const entry = await fetchRuntimeConfigEntry(LLM_PROVIDER_ROUTING_CONFIG_KEY);
    if (entry && cachedConfig && cachedVersion === entry.version) {
      return cachedConfig;
    }
    if (!entry) {
      if (cachedConfig && now - lastFetchTime < CACHE_TTL_MS) return cachedConfig;
      cachedConfig = DEFAULT_LLM_PROVIDER_ROUTING_CONFIG;
      cachedVersion = 0;
      lastFetchTime = now;
      return cachedConfig;
    }

    const parsed = LlmProviderRoutingConfigSchema.safeParse(entry.value);
    if (!parsed.success) {
      console.error(
        '[provider-routing] Invalid llm_provider_routing_config:',
        parsed.error.flatten()
      );
      return cachedConfig ?? DEFAULT_LLM_PROVIDER_ROUTING_CONFIG;
    }

    cachedConfig = parsed.data;
    cachedVersion = entry.version;
    lastFetchTime = now;
    return cachedConfig;
  } catch (err) {
    console.error('[provider-routing] Error fetching llm_provider_routing_config:', err);
    return cachedConfig ?? DEFAULT_LLM_PROVIDER_ROUTING_CONFIG;
  }
}

export function invalidateProviderRoutingCache(): void {
  cachedConfig = null;
  cachedVersion = 0;
  lastFetchTime = 0;
}

/** 某模型命中的 OpenRouter provider routing 参数；未命中或配置不可用时为 null。 */
export async function getProviderPreferencesForModel(
  openRouterModelId: string
): Promise<OpenRouterProviderPreferences | null> {
  const config = await getProviderRoutingConfig();
  return resolveProviderPreferences(config, openRouterModelId);
}
