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
const validatedAt = new Map<string, number>();
const HEAD_RECHECK_MS = 30 * 60_000;

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

/** Only a validation in this document can skip a background check for delisting or signed covers. */
export function needsLobbyHeadCheck(scope: string, now = Date.now()): boolean {
  return now - (validatedAt.get(scope) ?? -Infinity) >= HEAD_RECHECK_MS;
}

export function rememberLobbyRecommendation(scope: string, data: LobbyRecommendationData): void {
  batches.set(scope, data);
  validatedAt.set(scope, Date.now());
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
    Boolean(restoreBatchId) ||
    (Boolean(readLobbyRecommendation(scope)?.batch_id) &&
      previous !== undefined &&
      now - previous < NEW_BROWSE_AFTER_MS);
  return {
    action: resume ? 'resume' : 'open',
    request_id: createLobbyRequestId(),
    expected_batch_id: restoreBatchId ?? readLobbyRecommendation(scope)?.batch_id ?? null,
  };
}

/** Decide once per visit: crossing expiry while reading must never reorder the current screen. */
export function canReuseLobbyBatch(
  batch: LobbyRecommendationData | undefined,
  restoreBatchId?: string | null,
  now = Date.now()
): boolean {
  if (!batch?.enabled || !batch.batch_id) return false;
  // A long chat still returns to the exact batch from that document, including past its 24h expiry.
  if (restoreBatchId) return batch.batch_id === restoreBatchId;
  return Date.parse(batch.expires_at ?? '') > now;
}

/** Another tab may have advanced beyond a returnable server batch. Only this
 * document keeps that old reading order; persist the intact new server response separately. */
export function checkedLobbyReadFrame(
  batch: LobbyRecommendationData,
  current: LobbyRecommendationData
) {
  const visible = new Set(current.character_ids);
  const renewed = new Map(current.head_cards?.map((card) => [card.id, card]));
  return {
    batch,
    checkedAgainst: current.batch_id,
    order: batch.character_ids.filter((id) => visible.has(id)),
    cards: batch.head_cards
      ?.filter((card) => visible.has(card.id))
      .map((card) => renewed.get(card.id) ?? card),
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
