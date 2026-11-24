import { ProviderBalanceSchema, type ProviderBalance, type RelayProvider } from '@miniapp/shared';
import {
  isRelayRecord,
  relayManagementGet,
  RelayProviderError,
} from '../infrastructure/relay-provider-client.js';
import { readRelayProviderPolicy, relayConversion } from './relay-provider-policy.js';

const cache = new Map<RelayProvider, { at: number; value: ProviderBalance }>();
const inFlight = new Map<RelayProvider, Promise<ProviderBalance>>();

export function parseRelayBalance(body: unknown): number {
  if (
    !isRelayRecord(body) ||
    body.success !== true ||
    !isRelayRecord(body.data) ||
    typeof body.data.quota !== 'number' ||
    !Number.isFinite(body.data.quota) ||
    body.data.quota < 0
  )
    throw new RelayProviderError('invalid_body');
  return body.data.quota;
}

export async function probeRelayBalance(provider: RelayProvider): Promise<ProviderBalance> {
  const base = {
    provider,
    fetched_at: new Date().toISOString(),
    native_unit: 'quota' as const,
    native_balance: null,
    balance_cny: null,
    balance_usd: null,
    conversion_version: null,
  };
  try {
    const quota = parseRelayBalance(await relayManagementGet(provider, '/api/user/self'));
    const policy = await readRelayProviderPolicy(provider);
    const conversion = relayConversion(policy);
    return ProviderBalanceSchema.parse({
      ...base,
      status: 'ok',
      native_balance: quota,
      balance_cny: conversion.cnyPerQuota === null ? null : quota * conversion.cnyPerQuota,
      balance_usd: conversion.usdPerQuota === null ? null : quota * conversion.usdPerQuota,
      conversion_version: policy.conversion_version,
      error_code: null,
    });
  } catch (err) {
    const code = err instanceof RelayProviderError ? err.code : 'invalid_config';
    return {
      ...base,
      status: code === 'missing_credentials' ? 'not_configured' : 'failed',
      error_code: code,
    };
  }
}

/** Admin reads may share a short cache; monitoring always requests a new successful sample. */
export async function getRelayBalance(
  provider: RelayProvider,
  forceRefresh = false
): Promise<ProviderBalance> {
  const cached = cache.get(provider);
  if (!forceRefresh && cached && Date.now() - cached.at < 30_000) return cached.value;
  let pending = inFlight.get(provider);
  if (!pending) {
    pending = probeRelayBalance(provider)
      .then((value) => {
        if (value.status === 'ok') cache.set(provider, { at: Date.now(), value });
        return value;
      })
      .finally(() => inFlight.delete(provider));
    inFlight.set(provider, pending);
  }
  return pending;
}
