'use client';

import { useMemo } from 'react';
import type { CharacterSummary, ChatSession } from '@miniapp/shared';
import { useCharacterQuery, useCachedLobbyCharacters } from '@/lib/api/characters';
import { useEntryEnrichReady } from '@/lib/entry-phase';

export type LobbySummaryLookup =
  | { status: 'pending' }
  | { status: 'ready'; byId: ReadonlyMap<string, CharacterSummary>; canFetchDetails: boolean }
  | { status: 'unavailable' };

/**
 * 只订阅已有公开摘要，不为给历史行补名字而下载整个大厅。
 * 缺失摘要在P0结算后走normal补齐，避免重现N个critical详情请求（ST-MINIAPP-1Y）。
 */
export function useLobbySummaryLookup(): LobbySummaryLookup {
  const characters = useCachedLobbyCharacters()?.characters;
  const canFetchDetails = useEntryEnrichReady();
  return useMemo<LobbySummaryLookup>(() => {
    if (characters)
      return { status: 'ready', byId: new Map(characters.map((c) => [c.id, c])), canFetchDetails };
    return canFetchDetails ? { status: 'unavailable' } : { status: 'pending' };
  }, [characters, canFetchDetails]);
}

export function useSessionCharacter(session: ChatSession, lookup: LobbySummaryLookup) {
  const summary =
    lookup.status === 'ready' && !session.character_version_id
      ? lookup.byId.get(session.character_id)
      : undefined;
  // 缓存可立即展示；补缺详情仍等enrich/导航安静窗，不能与首屏列表抢critical。
  const { data } = useCharacterQuery(session.character_id, {
    enabled:
      !summary &&
      (lookup.status === 'unavailable' || (lookup.status === 'ready' && lookup.canFetchDetails)),
    sessionId: session.id,
    queuePriority: 'normal',
    staleTime: 60_000,
  });
  return summary ?? data?.character;
}
