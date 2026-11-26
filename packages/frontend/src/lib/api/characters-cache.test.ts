import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CharacterSummary, GetCharacterByIdData, GetCharactersData } from '@miniapp/shared';

const viewer = vi.hoisted(() => ({ id: 101 }));
vi.mock('@/lib/telegram/auth', () => ({ getRawInitData: () => '' }));
vi.mock('@/lib/telegram/user', () => ({ parseTelegramUser: () => ({ id: viewer.id }) }));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  apiClient: vi.fn(),
}));
import { apiClient } from './client';
import {
  cachedLobbyCharacterQueries,
  characterKeys,
  useCachedLobbyCharacters,
  useCharacterQuery,
} from './characters';
import { useSessionCharacter } from '@/components/conversations/use-session-character';

const card: CharacterSummary = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Fixture',
  description: '',
  avatar_url: '',
  personality_tags: [],
  author_name: 'Fixture',
  is_featured: false,
};
let client: QueryClient;
const cleanups: Array<() => void> = [];
let storage: Map<string, string>;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  viewer.id = 101;
  storage = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vi.mocked(apiClient).mockReset();
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function render(probe: () => null) {
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(probe)));
}
function observeCached() {
  return cachedLobbyCharacterQueries().map((options) => {
    const observer = new QueryObserver<GetCharactersData>(client, options);
    cleanups.push(observer.subscribe(() => {}));
    return observer;
  });
}
describe('passive public summaries', () => {
  it('reads only existing memory during chat entry without parsing persisted catalogues', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem');
    storage.set('miniapp:lobby-characters:v5:recommended', '{bad');
    client.setQueryData(characterKeys.publicHead(), { characters: [card] });
    let result: ReturnType<typeof useCachedLobbyCharacters>;
    render(() => {
      result = useCachedLobbyCharacters(false);
      return null;
    });
    expect(result!.characters).toEqual([card]);
    expect(getItem).not.toHaveBeenCalled();
    expect(apiClient).not.toHaveBeenCalled();
  });
  it('subscribes without catalogue dispatch on cold cache, invalidation or focus', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected catalogue fetch'));
    const observers = observeCached();
    await client.invalidateQueries();
    observers.forEach((observer) => observer.getCurrentQuery().onFocus());
    expect(observers.every((observer) => observer.getCurrentResult().data === undefined)).toBe(
      true
    );
    expect(apiClient).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
  it('reuses persisted summaries and merges existing memory/public-head data', () => {
    storage.set(
      'miniapp:lobby-characters:v5:recommended',
      JSON.stringify({ savedAt: Date.now() - 1000, data: { characters: [card] } })
    );
    client.setQueryData(characterKeys.publicHead(), {
      characters: [{ ...card, name: 'Fresh head' }],
    });
    let result: ReturnType<typeof useCachedLobbyCharacters>;
    render(() => {
      result = useCachedLobbyCharacters();
      return null;
    });
    expect(result!.characters).toHaveLength(1);
    // Existing cache remains usable; no full catalogue or private recommendation is fetched.
    expect(result!.characters[0]?.id).toBe(card.id);
    expect(result!.characters[0]?.name).toBe('Fresh head');
    expect(client.getQueryData(characterKeys.list('recommended'))).toEqual({ characters: [card] });
  });
  it.each(['broken', 'expired', 'future', 'shape'])(
    'drops %s snapshots without fetching',
    (kind) => {
      const key = 'miniapp:lobby-characters:v5:recommended';
      storage.set(
        key,
        kind === 'broken'
          ? '{bad'
          : JSON.stringify({
              savedAt:
                Date.now() + (kind === 'future' ? 60000 : kind === 'expired' ? -86400001 : -1),
              data: { characters: kind === 'shape' ? [{ id: 'invalid' }] : [card] },
            })
      );
      expect(observeCached()[0]?.getCurrentResult().data).toBeUndefined();
      expect(storage.has(key)).toBe(false);
    }
  );
  it('handles storage denial and still reads existing memory', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('denied');
      },
    });
    client.setQueryData(characterKeys.list('latest'), { characters: [card] });
    let result: ReturnType<typeof useCachedLobbyCharacters>;
    render(() => {
      result = useCachedLobbyCharacters();
      return null;
    });
    expect(result!.characters).toEqual([card]);
  });
});
describe('detail memory cache isolation', () => {
  it('uses cached summaries for current rows but never for a session-bound version', () => {
    const session = {
      id: 'session-a',
      character_id: card.id,
      title: null,
      last_message_at: null,
      last_message_preview: null,
      message_count: 1,
      pinned_at: null,
      created_at: '',
      updated_at: '',
    };
    const lookup = {
      status: 'ready' as const,
      byId: new Map([[card.id, card]]),
      canFetchDetails: false,
    };
    let value: ReturnType<typeof useSessionCharacter>;
    render(() => {
      value = useSessionCharacter(session, lookup);
      return null;
    });
    expect(value!).toEqual(card);
    render(() => {
      value = useSessionCharacter({ ...session, character_version_id: 'version-a' }, lookup);
      return null;
    });
    expect(value!).toBeUndefined();
    expect(apiClient).not.toHaveBeenCalled();
  });
  it('retains session/user keys, normal priority and a 60s row TTL without persistence', async () => {
    vi.useFakeTimers();
    const detail: GetCharacterByIdData = {
      character: { ...card, greeting: 'Version', creator_notes: '' },
    };
    vi.mocked(apiClient).mockResolvedValue(detail);
    let read!: () => Promise<unknown>;
    let isStale = true;
    let value: GetCharacterByIdData | undefined;
    function Probe({ session = 'session-a' }: { session?: string } = {}) {
      const query = useCharacterQuery(card.id, {
        sessionId: session,
        queuePriority: 'normal',
        staleTime: 60000,
      });
      read = () => query.refetch();
      isStale = query.isStale;
      value = query.data;
      return null;
    }
    render(Probe);
    await read();
    render(Probe);
    expect(value).toEqual(detail);
    expect(isStale).toBe(false);
    expect(apiClient).toHaveBeenLastCalledWith(
      expect.stringContaining('session_id=session-a'),
      expect.objectContaining({ queuePriority: 'normal', signal: expect.any(AbortSignal) })
    );
    vi.advanceTimersByTime(59999);
    render(Probe);
    expect(isStale).toBe(false);
    vi.advanceTimersByTime(2);
    render(Probe);
    expect(isStale).toBe(true);
    viewer.id = 202;
    render(Probe);
    expect(value).toBeUndefined();
    viewer.id = 101;
    render(() => Probe({ session: 'session-b' }));
    expect(value).toBeUndefined();
    expect(storage.size).toBe(0);
  });
});
