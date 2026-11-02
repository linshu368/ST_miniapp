import {
  DEFAULT_LOBBY_ROTATION_CONFIG,
  LOBBY_FEATURED_POSITION_COUNT,
  LobbyRankingParamsSchema,
  type LobbyRecommendationData,
  type LobbyRecommendationExposures,
  type LobbyRecommendationRequest,
  type LobbyRotationConfig,
} from '@miniapp/shared';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/db.js';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';
import { discoverableCharacterWhere } from '../creator/access.js';
import { applyPinnedOnly, buildRecommendedOrder } from './recommended-ranking.js';
import { loadCharacterRankingScores } from './ranking-stats.js';
import { resolveLobbyPinnedCharacters } from './pinned-characters.js';
import {
  buildRecommendationOrder,
  recommendationHash,
  type RecommendationCandidate,
} from './recommendation-ranking.js';
import {
  recordRecommendationExposures,
  updateRecommendation,
} from './recommendation-repository.js';

let configCache: { expires: number; value: LobbyRotationConfig } | null = null;
let configInflight: Promise<LobbyRotationConfig> | null = null;
let catalogCache: { expires: number; value: RecommendationCandidate[] } | null = null;
let catalogInflight: Promise<RecommendationCandidate[]> | null = null;

export function clearLobbyRecommendationCache() {
  configCache = null;
  catalogCache = null;
  configInflight = null;
  catalogInflight = null;
}

export async function loadLobbyRotationConfig(
  log: FastifyBaseLogger
): Promise<LobbyRotationConfig> {
  if (configCache && configCache.expires > Date.now()) return configCache.value;
  if (configInflight) return configInflight;
  configInflight = (async () => {
    const entry = await fetchRuntimeConfigEntry('lobby_ranking_params');
    const parsed = LobbyRankingParamsSchema.safeParse(entry?.value);
    if (!parsed.success && entry) {
      log.warn(
        { kind: 'sys', event: 'lobby_rotation.config_invalid' },
        '轮换配置无效，使用默认轮换参数'
      );
    }
    const value = parsed.success
      ? (parsed.data.rotation ?? DEFAULT_LOBBY_ROTATION_CONFIG)
      : DEFAULT_LOBBY_ROTATION_CONFIG;
    configCache = { expires: Date.now() + 60_000, value };
    return value;
  })().finally(() => {
    configInflight = null;
  });
  return configInflight;
}

async function loadCandidates(): Promise<RecommendationCandidate[]> {
  if (catalogCache && catalogCache.expires > Date.now()) return catalogCache.value;
  if (catalogInflight) return catalogInflight;
  catalogInflight = (async () => {
    const cards = await prisma.character.findMany({
      where: { ...discoverableCharacterWhere, is_test: false },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
      select: { id: true, name: true, description: true, tags: true },
      take: 10000,
    });
    const value = cards.map((card) => ({
      id: card.id,
      tags: Array.isArray(card.tags)
        ? card.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      canExplore: card.name.trim().length > 0 && card.description.trim().length > 0,
    }));
    catalogCache = { expires: Date.now() + 2000, value };
    return value;
  })().finally(() => {
    catalogInflight = null;
  });
  return catalogInflight;
}

export async function getLobbyRecommendation(
  userId: string,
  request: LobbyRecommendationRequest,
  log: FastifyBaseLogger
): Promise<LobbyRecommendationData> {
  const config = await loadLobbyRotationConfig(log);
  const [candidates, snapshot, pinned] = await Promise.all([
    loadCandidates(),
    loadCharacterRankingScores(),
    resolveLobbyPinnedCharacters(log),
  ]);
  const seed = recommendationHash(request.request_id);
  const ordered = snapshot
    ? buildRecommendedOrder({
        operatorOrdered: candidates,
        scores: snapshot.scores,
        minSample: snapshot.minSample,
        protectedPrefix: LOBBY_FEATURED_POSITION_COUNT,
        pinnedIds: pinned.characterIds,
        seed,
      })
    : applyPinnedOnly(candidates, pinned.characterIds);
  const matureCount = snapshot
    ? candidates.filter((c) => (snapshot.scores.get(c.id)?.sampleSize ?? 0) >= snapshot.minSample)
        .length
    : 0;
  // If there is not even a credible old prefix, use the operator order instead of shuffling an
  // all-cold directory. Otherwise the previous protected/pinned ranking remains the fallback.
  const fallbackOrder = (
    matureCount >= 4 ? ordered : applyPinnedOnly(candidates, pinned.characterIds)
  ).map((c) => c.id);
  const now = new Date();
  const generated: Array<{ headCount: number; repeatCount: number; degraded: boolean }> = [];
  const result = await updateRecommendation(prisma, userId, request, {
    now,
    config,
    visibleIds: candidates.map((candidate) => candidate.id),
    build: (exposures, recent) => {
      const order = buildRecommendationOrder({
        candidates: ordered,
        fallbackOrder,
        snapshot,
        exposures,
        recent,
        config,
        promotedIds: pinned.characterIds,
        fixedId: pinned.fixedCharacterId ?? null,
        seed,
        now: now.getTime(),
      });
      const previousHead = new Set(recent[0]?.characterIds ?? []);
      generated.push({
        headCount: order.headIds.length,
        repeatCount: order.headIds.filter((id) => previousHead.has(id)).length,
        degraded: order.degraded,
      });
      return order;
    },
  });
  const generatedSummary = generated[0];
  if (generatedSummary) {
    log.info(
      {
        kind: 'biz',
        event: 'lobby_rotation.generated',
        ...generatedSummary,
        action: request.action,
      },
      '推荐新批次已保存'
    );
  }
  return result;
}

export async function reportLobbyRecommendationExposures(
  userId: string,
  input: LobbyRecommendationExposures,
  _log: FastifyBaseLogger
): Promise<number> {
  const candidates = await loadCandidates();
  return recordRecommendationExposures(
    prisma,
    userId,
    input,
    candidates.map((card) => card.id),
    new Date()
  );
}
