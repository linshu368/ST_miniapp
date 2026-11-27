import {
  LlmModelProviderSchema,
  ProviderBalanceSchema,
  ProviderModelDirectorySchema,
  RelayProviderSchema,
  SurplusModelIdSchema,
  SurplusProviderMarketSchema,
  type LlmModelProvider,
  type RelayProvider,
} from '@miniapp/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readAdminAccessToken } from './textPostprocessApi';

async function readEnvelope(url: string, token?: string) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('data' in body)
  )
    throw new Error(`Model provider request failed (HTTP ${response.status})`);
  return body.data;
}

export async function fetchProviderModelDirectory(
  apiBaseUrl: string,
  provider: LlmModelProvider,
  forceRefresh = false
) {
  const id = LlmModelProviderSchema.parse(provider);
  const data = await readEnvelope(
    `${apiBaseUrl.replace(/\/+$/, '')}/api/platform/model-providers/${id}/models${forceRefresh ? '?refresh=1' : ''}`
  );
  const directory = ProviderModelDirectorySchema.parse(data);
  if (directory.provider !== id || directory.models.some((model) => model.provider !== id))
    throw new Error('Model provider response mismatch');
  return directory;
}

export async function fetchProviderBalance(
  client: SupabaseClient,
  apiBaseUrl: string,
  provider: RelayProvider,
  forceRefresh = false
) {
  const id = RelayProviderSchema.parse(provider);
  const token = await readAdminAccessToken(client);
  if (!token) throw new Error('Admin session expired');
  const balance = ProviderBalanceSchema.parse(
    await readEnvelope(
      `${apiBaseUrl.replace(/\/+$/, '')}/api/admin/model-providers/${id}/balance${forceRefresh ? '?refresh=1' : ''}`,
      token
    )
  );
  if (balance.provider !== id) throw new Error('Balance provider response mismatch');
  return balance;
}

/** Surplus 某模型各供应商的公开报价与 24h 表现（运营平台「模型供应商路由」填 Surplus 规则时参考） */
export async function fetchSurplusProviderMarket(
  client: SupabaseClient,
  apiBaseUrl: string,
  model: string
) {
  const id = SurplusModelIdSchema.parse(model);
  const token = await readAdminAccessToken(client);
  if (!token) throw new Error('Admin session expired');
  const market = SurplusProviderMarketSchema.parse(
    await readEnvelope(
      `${apiBaseUrl.replace(/\/+$/, '')}/api/admin/model-providers/surplus/market?model=${encodeURIComponent(id)}`,
      token
    )
  );
  if (market.model !== id) throw new Error('Market model response mismatch');
  return market;
}
