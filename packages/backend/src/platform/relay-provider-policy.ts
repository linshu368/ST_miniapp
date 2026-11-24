import {
  DEFAULT_LLM_RELAY_PROVIDER_CONFIG,
  LLM_RELAY_PROVIDER_CONFIG_KEY,
  LlmRelayProviderConfigSchema,
  type RelayProvider,
  type RelayProviderPolicy,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntryStrict } from './runtime-config.js';

export async function readRelayProviderPolicy(
  provider: RelayProvider
): Promise<RelayProviderPolicy> {
  const entry = await fetchRuntimeConfigEntryStrict(
    LLM_RELAY_PROVIDER_CONFIG_KEY,
    AbortSignal.timeout(5_000)
  );
  if (!entry) return { ...DEFAULT_LLM_RELAY_PROVIDER_CONFIG[provider] };
  return LlmRelayProviderConfigSchema.parse(entry.value)[provider];
}

export function relayConversion(policy: RelayProviderPolicy): {
  cnyPerQuota: number | null;
  usdPerQuota: number | null;
} {
  const cny =
    policy.quota_per_unit !== null && policy.cny_per_unit !== null
      ? policy.cny_per_unit / policy.quota_per_unit
      : null;
  const usd =
    cny !== null &&
    policy.usd_per_cny !== null &&
    policy.conversion_source &&
    policy.conversion_version
      ? cny * policy.usd_per_cny
      : null;
  return {
    cnyPerQuota: cny !== null && Number.isFinite(cny) ? cny : null,
    usdPerQuota: typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : null,
  };
}
