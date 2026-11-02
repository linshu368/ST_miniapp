'use client';

import {
  LobbyRecommendationDataSchema,
  type CharacterSummary,
  type LobbyRecommendationData,
  type LobbyRecommendationRequest,
} from '@miniapp/shared';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';

const CACHE_PREFIX = 'miniapp:lobby-recommendation:v1:';
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60_000;
const NEW_BROWSE_AFTER_MS = 30 * 60_000;
const batches = new Map<string, LobbyRecommendationData>();
const visits = new Map<string, number>();

export function lobbyViewerScope(): string {
  return String(parseTelegramUser(getRawInitData()).id ?? 'local-browser');
}

export function lobbyRecommendationCacheKey(scope: string): string {
  return `${CACHE_PREFIX}${scope}`;
}

export function createLobbyRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function')
    crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readLobbyRecommendation(scope: string): LobbyRecommendationData | undefined {
  const memory = batches.get(scope);
  if (memory) return memory;
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(lobbyRecommendationCacheKey(scope));
    if (!raw) return undefined;
    const cached: unknown = JSON.parse(raw);
    if (!cached || typeof cached !== 'object' || !('saved_at' in cached) || !('data' in cached))
      return undefined;
    if (
      typeof cached.saved_at !== 'number' ||
      Date.now() - cached.saved_at > MAX_CACHE_AGE_MS ||
      cached.saved_at > Date.now() + 60_000
    )
      return undefined;
    const parsed = LobbyRecommendationDataSchema.safeParse(cached.data);
    if (!parsed.success) return undefined;
    batches.set(scope, parsed.data);
    return parsed.data;
  } catch {
    return undefined;
  }
}

/** Only IDs and timestamps are private here; public card details keep their shared cache. */
export function rememberLobbyRecommendation(scope: string, data: LobbyRecommendationData): void {
  batches.set(scope, data);
  try {
    window.localStorage.setItem(
      lobbyRecommendationCacheKey(scope),
      JSON.stringify({ saved_at: Date.now(), data })
    );
  } catch {
    // Private mode and storage pressure must not prevent a batch from being shown.
  }
}

export function markLobbyVisit(scope: string): void {
  visits.set(scope, Date.now());
}

/** A new document has no visit entry. Explicit chat return wins over elapsed wall time. */
export function lobbyEntryRequest(
  scope: string,
  restoreBatchId?: string | null,
  now = Date.now()
): LobbyRecommendationRequest {
  const previous = visits.get(scope);
  const resume =
    Boolean(restoreBatchId) || (previous !== undefined && now - previous < NEW_BROWSE_AFTER_MS);
  return {
    action: resume ? 'resume' : 'open',
    request_id: createLobbyRequestId(),
    expected_batch_id: restoreBatchId ?? readLobbyRecommendation(scope)?.batch_id ?? null,
  };
}

/** Delisted IDs disappear in place; fresh public scores never move the remaining cards. */
export function projectLobbyOrder(
  characters: CharacterSummary[],
  orderedIds: readonly string[] | undefined
): CharacterSummary[] {
  if (!orderedIds) return characters;
  const byId = new Map(characters.map((character) => [character.id, character]));
  const ordered: CharacterSummary[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const character = byId.get(id);
    if (character && !seen.has(id)) {
      seen.add(id);
      ordered.push(character);
    }
  }
  // The server supplies the complete batch, including its tail. Appending the public
  // catalogue here could reintroduce ineligible cards and invent unowned exposures.
  return ordered;
}
