import { setTimeout as sleep } from 'node:timers/promises';
import type { RelayProvider } from '@miniapp/shared';
import { relayProviderFetch } from '../platform/relay-provider-http.js';
import { getRelayManagementConfig } from '../platform/runtime-config.js';

export type RelayFailureCode =
  | 'missing_credentials'
  | 'invalid_config'
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'invalid_body';
export class RelayProviderError extends Error {
  constructor(
    readonly code: RelayFailureCode,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number
  ) {
    super(`relay_provider_${code}`);
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 3_600_000) : undefined;
}
export function isRelayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The signal bounds body consumption too; JSON size is checked before any parsing. */
export async function readRelayJson(response: Response, limit = 1_048_576): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new RelayProviderError('invalid_body');
  }
  if (!response.body) throw new RelayProviderError('invalid_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new RelayProviderError('invalid_body');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RelayProviderError('invalid_body');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function relayGet(input: {
  provider: RelayProvider;
  url: string;
  headers: Record<string, string>;
  operation: string;
  timeoutMs?: number;
  attempts?: number;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? relayProviderFetch(input.provider, input.operation);
  const attempts = Math.min(2, Math.max(1, input.attempts ?? 2));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(input.url, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', ...input.headers },
        signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RelayProviderError(
          response.status === 401 || response.status === 403
            ? 'auth_failed'
            : response.status === 429
              ? 'rate_limited'
              : 'upstream',
          response.status,
          response.status === 429 ? retryAfterMs(response.headers.get('retry-after')) : undefined
        );
      }
      return await readRelayJson(response);
    } catch (err) {
      const error =
        err instanceof RelayProviderError
          ? err
          : new RelayProviderError(
              err instanceof Error && ['TimeoutError', 'AbortError'].includes(err.name)
                ? 'timeout'
                : 'upstream'
            );
      const retryable =
        error.code === 'timeout' ||
        (error.code === 'upstream' && (!error.httpStatus || error.httpStatus >= 500));
      if (!retryable || attempt + 1 === attempts) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
  throw new RelayProviderError('upstream');
}

export async function relayManagementGet(
  provider: RelayProvider,
  path: '/api/user/self' | '/api/log/self' | '/api/token/',
  query?: URLSearchParams
): Promise<unknown> {
  let config: ReturnType<typeof getRelayManagementConfig>;
  try {
    config = getRelayManagementConfig(provider);
  } catch {
    throw new RelayProviderError('invalid_config');
  }
  if (!config.baseUrl || !config.apiKey || !config.userId)
    throw new RelayProviderError('missing_credentials');
  return relayGet({
    provider,
    url: `${config.baseUrl}${path}${query ? `?${query}` : ''}`,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'New-API-User': config.userId },
    operation: path === '/api/user/self' ? 'provider.balance' : 'generation.call_cost_lookup',
  });
}
