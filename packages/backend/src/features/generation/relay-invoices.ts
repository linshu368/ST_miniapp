import type { RelayProvider } from '@miniapp/shared';
import { createHash } from 'node:crypto';
import {
  getLlmProviderRuntimeConfig,
  getRelayManagementConfig,
} from '../../platform/runtime-config.js';
import {
  isRelayRecord,
  relayGet,
  relayManagementGet,
  RelayProviderError,
} from '../../infrastructure/relay-provider-client.js';
import { relayIdentity, relayTokenCount } from './relay-usage.js';
import { relayAccountRef } from './relay-call-ledger.js';

interface KeyScope {
  tokenId: number;
  userId: number;
  groups: string[];
}
const scopes = new Map<string, { at: number; value: KeyScope | null }>();

/** Management lists contain secrets on some versions; only a Key's ID/groups leave this function. */
async function keyScope(provider: RelayProvider): Promise<KeyScope | null> {
  const call = getLlmProviderRuntimeConfig(provider);
  const ref = `${relayAccountRef(provider)}:${createHash('sha256').update(call.apiKey).digest('hex')}`;
  const cached = scopes.get(ref);
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  const management = getRelayManagementConfig(provider);
  const summary = await relayGet({
    provider,
    url: `${management.baseUrl}/api/usage/token/`,
    headers: { Authorization: `Bearer ${call.apiKey}` },
    operation: 'generation.call_cost_lookup',
  });
  const data = isRelayRecord(summary) && isRelayRecord(summary.data) ? summary.data : null;
  if (!data || typeof data.name !== 'string') return null;
  const candidates: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page++) {
    const raw = await relayManagementGet(
      provider,
      '/api/token/',
      new URLSearchParams({ p: String(page), page_size: '100' })
    );
    const envelope =
      isRelayRecord(raw) && raw.success === true && isRelayRecord(raw.data) ? raw.data : null;
    const items = envelope?.items;
    if (!envelope || !Array.isArray(items)) throw new RelayProviderError('invalid_body');
    for (const item of items)
      if (isRelayRecord(item) && item.name === data.name && keyMatches(item, call.apiKey))
        candidates.push(item);
    if (items.length < 100 || (typeof envelope.total === 'number' && envelope.total <= page * 100))
      break;
    if (page === 5) return null;
  }
  const candidate = candidates.length === 1 ? candidates[0] : null;
  const tokenId = relayTokenCount(candidate?.id);
  let groups: unknown = candidate?.groups;
  if (typeof groups === 'string') {
    try {
      groups = JSON.parse(groups);
    } catch {
      groups = [];
    }
  }
  const allowed =
    candidate?.group_mode === 'multiple' && Array.isArray(groups) ? groups : [candidate?.group];
  const value =
    candidate &&
    tokenId !== null &&
    tokenId > 0 &&
    String(candidate.user_id) === management.userId &&
    allowed.every((g) => typeof g === 'string')
      ? { tokenId, userId: Number(management.userId), groups: allowed as string[] }
      : null;
  scopes.set(ref, { at: Date.now(), value });
  return value;
}

function keyMatches(token: Record<string, unknown>, key: string): boolean {
  const normalized = key.replace(/^sk-/, '');
  if (typeof token.key === 'string') {
    const value = token.key.replace(/^sk-/, '');
    if (value === normalized) return true;
    const parts = value.split(/\*+|\.{3,}|…/);
    if (parts.length === 2 && parts[0]!.length >= 4 && parts[1]!.length >= 4)
      return normalized.startsWith(parts[0]!) && normalized.endsWith(parts[1]!);
  }
  return (
    typeof token.key_hint === 'string' &&
    token.key_hint.length === 8 &&
    normalized.startsWith(token.key_hint.slice(0, 4)) &&
    normalized.endsWith(token.key_hint.slice(4))
  );
}

export interface RelayInvoice {
  logId: string;
  quota: number;
  promptTokens: number | null;
  completionTokens: number | null;
}
export type InvoiceLookup =
  | { status: 'matched'; invoice: RelayInvoice }
  | { status: 'pending' | 'unavailable' | 'ambiguous' | 'conflict' };

/** Never associate by timestamp/model similarity. All pages must be exhausted before claiming uniqueness. */
export async function lookupRelayInvoice(input: {
  provider: RelayProvider;
  requestId: string | null;
  model: string;
  dispatchedAt: Date;
  accountRef: string | null;
}): Promise<InvoiceLookup> {
  if (!input.requestId || input.accountRef !== relayAccountRef(input.provider))
    return { status: 'unavailable' };
  const scope = await keyScope(input.provider);
  if (!scope) return { status: 'unavailable' };
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page++) {
    const query = new URLSearchParams({
      p: String(page),
      page_size: '100',
      request_id: input.requestId,
      start_timestamp: String(Math.floor(input.dispatchedAt.getTime() / 1000) - 60),
      end_timestamp: String(Math.floor(input.dispatchedAt.getTime() / 1000) + 600),
    });
    const raw = await relayManagementGet(input.provider, '/api/log/self', query);
    const data =
      isRelayRecord(raw) && raw.success === true && isRelayRecord(raw.data) ? raw.data : null;
    if (!data || !Array.isArray(data.items)) throw new RelayProviderError('invalid_body');
    rows.push(
      ...data.items.filter(isRelayRecord).filter((row) => row.request_id === input.requestId)
    );
    if (data.items.length < 100 || (typeof data.total === 'number' && data.total <= page * 100))
      break;
    if (page === 5) return { status: 'pending' };
  }
  const unique = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = String(row.id);
    const previous = unique.get(id);
    if (
      previous &&
      ['request_id', 'quota', 'type', 'user_id', 'token_id', 'model_name', 'group'].some(
        (key) => previous[key] !== row[key]
      )
    )
      return { status: 'conflict' };
    unique.set(id, row);
  }
  if (unique.size > 1) return { status: 'ambiguous' };
  const row = [...unique.values()][0];
  if (!row) return { status: 'pending' };
  if (
    row.type !== 2 ||
    row.user_id !== scope.userId ||
    row.token_id !== scope.tokenId ||
    row.model_name !== input.model ||
    !scope.groups.includes(String(row.group))
  )
    return { status: 'conflict' };
  const quota =
    typeof row.quota === 'number' && Number.isFinite(row.quota) && row.quota >= 0
      ? row.quota
      : null;
  const logId = relayIdentity(
    typeof row.id === 'number' && Number.isSafeInteger(row.id) ? String(row.id) : row.id
  );
  if (quota === null || !logId) return { status: 'unavailable' };
  return {
    status: 'matched',
    invoice: {
      logId,
      quota,
      promptTokens: relayTokenCount(row.prompt_tokens),
      completionTokens: relayTokenCount(row.completion_tokens),
    },
  };
}
