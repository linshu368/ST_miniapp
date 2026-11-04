import {
  DEFAULT_LOBBY_ROTATION_CONFIG,
  LOBBY_FEATURED_POSITION_COUNT,
  LOBBY_ROTATION_HEAD_SIZE,
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
  readReusableRecommendation,
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
    // Only completeness is used by exploration. Keep every character's description in
    // Postgres instead of moving the whole catalog of text to the ranking process.
    const cards = await prisma.$queryRaw<
      Array<{ id: string; tags: unknown; can_explore: boolean }>
    >`
      SELECT c.id, c.tags,
        (c.name ~ '[^[:space:]]' AND c.description ~ '[^[:space:]]') AS can_explore
      FROM app_core.characters c
      WHERE NOT c.is_test AND app_core.can_discover_character(c.id)
      ORDER BY c.sort_order ASC, c.created_at DESC LIMIT 10000
    `;
    const value = cards.map((card) => ({
      id: card.id,
      tags: Array.isArray(card.tags)
        ? card.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      canExplore: card.can_explore,
    }));
    catalogCache = { expires: Date.now() + 2000, value };
    return value;
  })().finally(() => {
    catalogInflight = null;
  });
  return catalogInflight;
}

async function prepareRanking(log: FastifyBaseLogger, seed?: number) {
  const [candidates, snapshot, pinned] = await Promise.all([
    loadCandidates(),
    loadCharacterRankingScores(),
    resolveLobbyPinnedCharacters(log),
  ]);
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
  return { candidates, snapshot, pinned, ordered, fallbackOrder };
}

export async function getPublicLobbyHeadOrder(log: FastifyBaseLogger): Promise<string[]> {
  const { fallbackOrder } = await prepareRanking(log);
  return fallbackOrder;
}

async function filterVisibleBatch(
  batch: LobbyRecommendationData
): Promise<LobbyRecommendationData> {
  if (!batch.character_ids.length) return batch;
  const rows = await prisma.character.findMany({
    where: { ...discoverableCharacterWhere, is_test: false, id: { in: batch.character_ids } },
    select: { id: true },
  });
  const visible = new Set(rows.map((row) => row.id));
  const ids = batch.character_ids.filter((id) => visible.has(id));
  return { ...batch, character_ids: ids, head_ids: ids.slice(0, LOBBY_ROTATION_HEAD_SIZE) };
}

export async function getLobbyRecommendation(
  userId: string,
  request: LobbyRecommendationRequest,
  log: FastifyBaseLogger
): Promise<LobbyRecommendationData> {
  const now = new Date();
  const saved = await readReusableRecommendation(prisma, userId, request, now);
  if (saved) {
    // A role may have gone private since this order was saved. Revalidate just IDs;
    // skip config, scoring, candidate text, and the transaction used for new batches.
    return filterVisibleBatch(saved);
  }
  const seed = recommendationHash(request.request_id);
  const [config, { candidates, snapshot, pinned, ordered, fallbackOrder }] = await Promise.all([
    loadLobbyRotationConfig(log),
    prepareRanking(log, seed),
  ]);
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
  return filterVisibleBatch(result);
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
