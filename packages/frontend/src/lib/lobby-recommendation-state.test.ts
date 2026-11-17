import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSummary, LobbyRecommendationData } from '@miniapp/shared';
import {
  canReuseLobbyBatch,
  checkedLobbyReadFrame,
  createLobbyRequestId,
  lobbyEntryRequest,
  lobbyRecommendationCacheKey,
  lobbyViewerScope,
  markLobbyVisit,
  projectLobbyOrder,
  readLobbyRecommendation,
  rememberLobbyRecommendation,
} from './lobby-recommendation-state';
import { readLobbyReturnSnapshot, saveLobbyReturnSnapshot } from './lobby-return';

const auth = vi.hoisted(() => ({ id: 71 }));
vi.mock('@/lib/telegram/auth', () => ({
  getRawInitData: () => new URLSearchParams({ user: JSON.stringify({ id: auth.id }) }).toString(),
}));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const firstId = '10000000-0000-4000-8000-000000000001';
const secondId = '10000000-0000-4000-8000-000000000002';
const batchId = '50000000-0000-4000-8000-000000000001';
const batch: LobbyRecommendationData = {
  enabled: true,
  degraded: false,
  batch_id: batchId,
  generated_at: '2026-11-02T01:00:00.000Z',
  expires_at: '2026-11-03T01:00:00.000Z',
  character_ids: [secondId, firstId],
  head_ids: [secondId, firstId],
  previous_batch_id: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T01:00:00Z'));
  vi.stubGlobal('window', { localStorage: storage(), sessionStorage: storage() });
  auth.id = 71;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('private recommendation state', () => {
  it('separates user caches and validates persisted shapes', () => {
    rememberLobbyRecommendation('cache-user-a', batch);
    expect(readLobbyRecommendation('cache-user-a')).toEqual(batch);
    expect(readLobbyRecommendation('cache-user-b')).toBeUndefined();
    window.localStorage.setItem(
      lobbyRecommendationCacheKey('invalid'),
      JSON.stringify({ saved_at: Date.now(), data: { ...batch, head_ids: ['not-an-id'] } })
    );
    expect(readLobbyRecommendation('invalid')).toBeUndefined();
    window.localStorage.setItem(
      lobbyRecommendationCacheKey('expired'),
      JSON.stringify({ saved_at: Date.now() - 31 * 86400_000, data: batch })
    );
    expect(readLobbyRecommendation('expired')).toBeUndefined();
  });

  it('opens a new document, resumes short returns and opens after a long absence', () => {
    const scope = 'entry-time';
    rememberLobbyRecommendation(scope, batch);
    expect(lobbyEntryRequest(scope).action).toBe('open');
    markLobbyVisit(scope);
    expect(lobbyEntryRequest(scope).action).toBe('resume');
    vi.advanceTimersByTime(30 * 60_000);
    expect(lobbyEntryRequest(scope).action).toBe('open');
    // The 24h expiry belongs to the server. Explicit chat return always preserves its batch.
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(lobbyEntryRequest(scope, batchId)).toMatchObject({
      action: 'resume',
      expected_batch_id: batchId,
    });
  });

  it('reuses only a valid batch and preserves the exact one when returning after expiry', () => {
    expect(canReuseLobbyBatch(undefined)).toBe(false);
    expect(canReuseLobbyBatch({ ...batch, enabled: false })).toBe(false);
    expect(canReuseLobbyBatch(batch)).toBe(true);
    expect(canReuseLobbyBatch(batch, 'different-batch')).toBe(false);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(canReuseLobbyBatch(batch)).toBe(false);
    expect(canReuseLobbyBatch(batch, batchId)).toBe(true);
  });

  it('keeps only still-visible cards in an old reading frame while persisting the authoritative batch', () => {
    const card = (id: string, name: string) => ({
      id,
      name,
      description: '',
      avatar_url: '',
      personality_tags: [],
      author_name: '',
      is_featured: false,
    });
    const original = { ...batch, head_cards: [card(secondId, 'removed'), card(firstId, 'old')] };
    const current = {
      ...batch,
      batch_id: '50000000-0000-4000-8000-000000000003',
      character_ids: [firstId],
      head_ids: [firstId],
      head_cards: [card(firstId, 'fresh')],
    };
    const frame = checkedLobbyReadFrame(original, current);
    rememberLobbyRecommendation('checked-frame', current);
    expect(frame.order).toEqual([firstId]);
    expect(frame.cards?.map((c) => c.name)).toEqual(['fresh']);
    expect(frame.batch.batch_id).toBe(original.batch_id);
    expect(readLobbyRecommendation('checked-frame')).toEqual(current);
  });

  it('starts with open when this account has never received a batch', () => {
    markLobbyVisit('account-without-a-batch');
    expect(lobbyEntryRequest('account-without-a-batch').action).toBe('open');
    expect(lobbyEntryRequest('account-without-a-batch').expected_batch_id).toBeNull();
  });

  it('keeps stored order while refreshing details and removing delisted cards', () => {
    const card = (id: string, name: string) => ({ id, name }) as CharacterSummary;
    const cards = [card(firstId, '新版名字'), card('new', '新上架'), card(secondId, '第二张')];
    const ordered = projectLobbyOrder(cards, [secondId, 'delisted', firstId, firstId]);
    expect(ordered.map((item) => item.id)).toEqual([secondId, firstId]);
    expect(ordered[1]?.name).toBe('新版名字');
    expect(projectLobbyOrder(cards, undefined)).toBe(cards);
  });

  it('generates a valid request UUID in older WebViews too', () => {
    vi.stubGlobal('crypto', undefined);
    expect(createLobbyRequestId()).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    );
    expect(createLobbyRequestId()).not.toEqual(createLobbyRequestId());
  });

  it('keeps chat return past 24h but does not share its position with another account', () => {
    saveLobbyReturnSnapshot({
      sort: 'recommended',
      query: '',
      anchorCharacterId: firstId,
      neighborCharacterIds: [secondId],
      loadedCharacterIds: [secondId, firstId],
      anchorViewportTop: 300,
      scrollY: 1500,
      viewportWidth: 390,
      recommendationBatchId: batchId,
    });
    vi.advanceTimersByTime(25 * 60 * 60_000);
    expect(readLobbyReturnSnapshot()?.recommendationBatchId).toBe(batchId);
    auth.id = 72;
    expect(lobbyViewerScope()).toBe('72');
    expect(readLobbyReturnSnapshot()).toBeNull();
    auth.id = 71;
    expect(readLobbyReturnSnapshot()?.scrollY).toBe(1500);
  });

  it('storage failures do not prevent memory-backed browsing', () => {
    vi.stubGlobal('window', {
      localStorage: {
        setItem: () => {
          throw new Error('quota');
        },
        getItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(() => rememberLobbyRecommendation('private-mode', batch)).not.toThrow();
    expect(readLobbyRecommendation('private-mode')).toEqual(batch);
    expect(readLobbyRecommendation('blocked')).toBeUndefined();
  });
});
