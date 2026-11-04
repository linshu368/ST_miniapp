import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOBBY_RANKING_PARAMS,
  DEFAULT_LOBBY_ROTATION_CONFIG,
  LobbyRankingParamsSchema,
  LobbyRecommendationExposuresSchema,
  LobbyRecommendationDataSchema,
  LobbyRecommendationRequestSchema,
  LobbyRotationConfigSchema,
} from '@miniapp/shared';
import {
  buildRecommendationOrder,
  exposureWeight,
  QUALIFIED_QUALITY_VERSION,
  type BuildRecommendationInput,
} from './recommendation-ranking.js';

const now = Date.parse('2026-11-02T00:00:00.000Z');
const day = 86_400_000;
function input(count = 30): BuildRecommendationInput {
  const candidates = Array.from({ length: count }, (_, i) => ({
    id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    tags: [`genre-${i % 5}`],
    canExplore: true,
  }));
  return {
    candidates,
    snapshot: {
      minSample: 20,
      scores: new Map(
        candidates.map((c) => [
          c.id,
          {
            score: 80,
            sampleSize: 30,
            qualityVersion: QUALIFIED_QUALITY_VERSION,
            trustedAt: now,
            trustedScore: 80,
            trustedSampleSize: 30,
          },
        ])
      ),
    },
    config: { ...DEFAULT_LOBBY_ROTATION_CONFIG, enabled: true, rollout_percent: 100 },
    exposures: new Map(),
    recent: [],
    promotedIds: [],
    fixedId: null,
    now,
    seed: 15,
  };
}

describe('personal quality rotation', () => {
  it('keeps at most two adjacent repeats with 22 qualified candidates and one fixed card', () => {
    const base = input(22);
    base.fixedId = base.candidates[0]!.id;
    for (let seed = 1; seed <= 100; seed++) {
      const first = buildRecommendationOrder({ ...base, seed });
      const next = buildRecommendationOrder({
        ...base,
        seed: seed + 1,
        recent: [{ id: 'previous', characterIds: first.headIds }],
      });
      expect(next.headIds).toHaveLength(12);
      expect(next.headIds.filter((id) => first.headIds.includes(id)).length).toBeLessThanOrEqual(2);
      expect(new Set(next.characterIds).size).toBe(22);
      expect(next.headIds[0]).toBe(base.fixedId);
      expect(next.degraded).toBe(false);
    }
  });

  it('puts strongest cards first and limits unknown cards to the last two head slots', () => {
    const base = input(30);
    base.candidates.forEach((c, i) => {
      const stat = base.snapshot!.scores.get(c.id)!;
      if (i >= 20) {
        stat.sampleSize = 0;
        stat.trustedScore = undefined;
        stat.trustedAt = undefined;
      } else if (i >= 8) {
        stat.score = 55;
        stat.trustedScore = 55;
      }
    });
    const result = buildRecommendationOrder(base);
    expect(
      result.headIds.slice(0, 4).every((id) => base.snapshot!.scores.get(id)!.score >= 70)
    ).toBe(true);
    expect(
      result.headIds.slice(0, 10).every((id) => base.snapshot!.scores.get(id)!.sampleSize >= 20)
    ).toBe(true);
    expect(
      result.headIds.slice(10).every((id) => base.snapshot!.scores.get(id)!.sampleSize === 0)
    ).toBe(true);
  });

  it('reports limited quality inventory instead of duplicating cards or promising the repeat limit', () => {
    const base = input(8);
    const first = buildRecommendationOrder(base);
    const next = buildRecommendationOrder({
      ...base,
      recent: [{ id: 'previous', characterIds: first.headIds }],
    });
    expect(next.characterIds).toHaveLength(8);
    expect(new Set(next.characterIds).size).toBe(8);
    expect(next.degraded).toBe(true);
  });

  it('falls back when reliable inventory cannot support the head without exceeding exploration slots', () => {
    const base = input(30);
    for (const c of base.candidates.slice(8)) {
      base.snapshot!.scores.set(c.id, {
        score: 50,
        sampleSize: 0,
        qualityVersion: QUALIFIED_QUALITY_VERSION,
      });
    }
    const result = buildRecommendationOrder(base);
    expect(result.degraded).toBe(true);
    expect(result.characterIds).toEqual(base.candidates.map((c) => c.id));
    base.fallbackOrder = [...base.candidates.map((c) => c.id)].reverse();
    expect(buildRecommendationOrder(base).characterIds).toEqual(base.fallbackOrder);
  });

  it('recovers continuously, allows a bounded comeback, and does not treat unsighted cards as exposed', () => {
    expect(exposureWeight(undefined, now, true)).toBe(1);
    expect(exposureWeight(now, now, true)).toBe(0.15);
    expect(exposureWeight(now - 2 * day, now, true)).toBe(0.15);
    expect(exposureWeight(now - 5 * day, now, true)).toBeGreaterThan(0.15);
    expect(exposureWeight(now - 7 * day, now, true)).toBe(1);
    expect(exposureWeight(now - 60 * day, now, true)).toBe(1.2);
    expect(exposureWeight(now - 60 * day, now, false)).toBe(1);
  });

  it('keeps qualified historical quality during a quiet period, but only explores expired evidence', () => {
    const base = input(14);
    const recentHistory = base.candidates[12]!.id;
    const expired = base.candidates[13]!.id;
    base.snapshot!.scores.set(recentHistory, {
      score: 50,
      sampleSize: 0,
      qualityVersion: QUALIFIED_QUALITY_VERSION,
      trustedScore: 90,
      trustedAt: now - 60 * day,
    });
    // Even if the whole job has not run again, an old mature n must not masquerade as fresh evidence.
    base.snapshot!.scores.set(expired, {
      score: 99,
      sampleSize: 40,
      qualityVersion: QUALIFIED_QUALITY_VERSION,
      trustedScore: 99,
      trustedAt: now - 91 * day,
    });
    base.fixedId = recentHistory;
    const result = buildRecommendationOrder(base);
    expect(result.headIds[0]).toBe(recentHistory);
    expect(result.headIds.indexOf(expired)).toBeGreaterThanOrEqual(10);
  });

  it('never replaces current poor evidence with an old high score or an operator boost', () => {
    const base = input(20);
    const bad = base.candidates[0]!.id;
    base.snapshot!.scores.set(bad, {
      score: 10,
      sampleSize: 40,
      qualityVersion: QUALIFIED_QUALITY_VERSION,
      trustedScore: 95,
      trustedAt: now,
    });
    base.promotedIds = [bad];
    base.fixedId = bad;
    expect(buildRecommendationOrder(base).headIds).not.toContain(bad);
  });

  it('does not bootstrap trusted quality from old unqualified scores', () => {
    const base = input(30);
    for (const stat of base.snapshot!.scores.values()) stat.qualityVersion = undefined;
    const result = buildRecommendationOrder(base);
    expect(result.degraded).toBe(true);
    expect(result.characterIds).toEqual(base.candidates.map((c) => c.id));
    expect(buildRecommendationOrder({ ...base, snapshot: null }).characterIds).toEqual(
      result.characterIds
    );
  });

  it('marks a zero-repeat setting degraded when the explicit fixed card must repeat', () => {
    const base = input(30);
    base.config.max_repeat = 0;
    base.fixedId = base.candidates[0]!.id;
    const first = buildRecommendationOrder(base);
    const next = buildRecommendationOrder({
      ...base,
      recent: [{ id: 'previous', characterIds: first.headIds }],
    });
    expect(next.degraded).toBe(true);
  });

  it('is deterministic for a request ID and uses randomness only within the constraints', () => {
    const base = input();
    expect(buildRecommendationOrder(base)).toEqual(buildRecommendationOrder(base));
    expect(buildRecommendationOrder({ ...base, seed: 198 }).headIds).not.toEqual(
      buildRecommendationOrder(base).headIds
    );
  });
});

describe('rotation consumer contracts', () => {
  it('keeps old managed ranking configurations valid and defaults automatic rotation to 24h', () => {
    expect(LobbyRankingParamsSchema.safeParse(DEFAULT_LOBBY_RANKING_PARAMS).success).toBe(true);
    expect(DEFAULT_LOBBY_ROTATION_CONFIG.interval_hours).toBe(24);
    expect(DEFAULT_LOBBY_ROTATION_CONFIG.enabled).toBe(true);
    expect(DEFAULT_LOBBY_ROTATION_CONFIG.rollout_percent).toBe(100);
    expect(
      LobbyRotationConfigSchema.safeParse({
        ...DEFAULT_LOBBY_ROTATION_CONFIG,
        exploration_count: 3,
      }).success
    ).toBe(false);
  });
  it('accepts legacy gate fields without limiting rotation or changing ranking parameters', () => {
    const parsed = LobbyRankingParamsSchema.parse({
      ...DEFAULT_LOBBY_RANKING_PARAMS,
      rotation: {
        ...DEFAULT_LOBBY_ROTATION_CONFIG,
        enabled: false,
        rollout_percent: 10,
        interval_hours: 24,
        max_repeat: 1,
        exploration_count: 1,
      },
    });
    expect(parsed.rotation).toEqual({
      enabled: true,
      rollout_percent: 100,
      interval_hours: 24,
      max_repeat: 1,
      exploration_count: 1,
    });
  });
  it('accepts legacy batches and rejects a partially loaded or reordered head', () => {
    const head_ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ];
    const batch = {
      enabled: true,
      degraded: false,
      batch_id: null,
      generated_at: null,
      expires_at: null,
      previous_batch_id: null,
      character_ids: head_ids,
      head_ids,
    };
    const head_cards = head_ids.map((id) => ({
      id,
      name: '角色',
      description: '',
      avatar_url: '',
      personality_tags: [],
      author_name: '',
      is_featured: false,
    }));
    expect(LobbyRecommendationDataSchema.safeParse(batch).success).toBe(true);
    expect(LobbyRecommendationDataSchema.safeParse({ ...batch, head_cards }).success).toBe(true);
    expect(
      LobbyRecommendationDataSchema.safeParse({ ...batch, head_cards: head_cards.slice(1) }).success
    ).toBe(false);
    expect(
      LobbyRecommendationDataSchema.safeParse({ ...batch, head_cards: [...head_cards].reverse() })
        .success
    ).toBe(false);
  });
  it('rejects caller-selected identity, invalid request IDs, and unbounded exposure arrays', () => {
    const id = input().candidates[0]!.id;
    expect(
      LobbyRecommendationRequestSchema.safeParse({ action: 'refresh', request_id: id, user_id: id })
        .success
    ).toBe(false);
    expect(
      LobbyRecommendationRequestSchema.safeParse({ action: 'refresh', request_id: 'bad' }).success
    ).toBe(false);
    expect(
      LobbyRecommendationExposuresSchema.safeParse({
        batch_id: id,
        character_ids: Array(41).fill(id),
      }).success
    ).toBe(false);
  });
});
