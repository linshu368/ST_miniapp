import { LOBBY_ROTATION_HEAD_SIZE, type LobbyRotationConfig } from '@miniapp/shared';
import type { CardScore, RankingSnapshot } from './ranking-stats.js';

export const QUALIFIED_QUALITY_VERSION = 'qualified-v1';
const DAY = 86_400_000;
const RELIABLE_SCORE = 40;
const TOP_SCORE = 70;
const TRUSTED_MAX_AGE = 90 * DAY;

export interface RecommendationCandidate {
  id: string;
  tags: readonly string[];
  /** A discoverable card must also have usable presentation content to use an exploration slot. */
  canExplore: boolean;
}
export interface RecentRecommendationHead {
  id: string;
  characterIds: string[];
}
export interface BuildRecommendationInput {
  candidates: readonly RecommendationCandidate[];
  /** Existing protected quality order, used only when the new head cannot be formed. */
  fallbackOrder?: readonly string[];
  snapshot: RankingSnapshot | null;
  exposures: ReadonlyMap<string, number>;
  recent: readonly RecentRecommendationHead[];
  config: LobbyRotationConfig;
  now: number;
  seed: number;
}
export interface RecommendationOrder {
  characterIds: string[];
  headIds: string[];
  degraded: boolean;
}

/** 新用户保护期：注册后这么久内，首页头部固定为分数最高的一批，不做个性化轮换。 */
export const NEW_USER_FIXED_HEAD_DAYS = 7;

export function isNewUserFixedHeadWindow(createdAt: string | undefined, now: number): boolean {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return false;
  return now - created < NEW_USER_FIXED_HEAD_DAYS * DAY;
}

/**
 * 新用户固定头部：直接取已有的受保护质量顺序（分数降序，样本太少时回落运营顺序），
 * 不做抽样、曝光惩罚和与上一批的去重，所以同一时期所有新用户看到同一批，换批也不变。
 */
export function buildNewUserOrder(
  candidates: readonly RecommendationCandidate[],
  fixedOrder: readonly string[]
): RecommendationOrder {
  const visible = new Set(candidates.map((c) => c.id));
  const characterIds = [...new Set([...fixedOrder, ...candidates.map((c) => c.id)])].filter((id) =>
    visible.has(id)
  );
  return {
    characterIds,
    headIds: characterIds.slice(0, LOBBY_ROTATION_HEAD_SIZE),
    degraded: false,
  };
}

/** Bounded recovery is independent of quality; unseen cards have no exposure penalty. */
export function exposureWeight(lastSeenAt: number | undefined, now: number, trusted: boolean) {
  if (lastSeenAt === undefined) return 1;
  const days = Math.max(0, now - lastSeenAt) / DAY;
  if (days <= 2) return 0.15;
  if (days < 7) return 0.15 + ((days - 2) / 5) * 0.85;
  if (days < 14 || !trusted) return 1;
  return 1 + Math.min(0.2, ((days - 14) / 7) * 0.2);
}

/** Stable bucket assignment also makes fixed-seed tests reproducible. */
export function recommendationHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function rngFrom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quality(stat: CardScore | undefined, minSample: number, now: number) {
  if (stat?.qualityVersion !== QUALIFIED_QUALITY_VERSION) return null;
  // Current mature evidence wins even if it is worse than the previous trusted observation.
  if (stat.sampleSize >= minSample) {
    return stat.trustedAt !== undefined && now - stat.trustedAt <= TRUSTED_MAX_AGE
      ? stat.score
      : null;
  }
  if (
    stat.trustedScore !== undefined &&
    stat.trustedAt !== undefined &&
    now - stat.trustedAt <= TRUSTED_MAX_AGE
  ) {
    return stat.trustedScore;
  }
  return null;
}

/** Full-tail order is captured once; only the first twelve are sampled. */
export function buildRecommendationOrder(input: BuildRecommendationInput): RecommendationOrder {
  const { snapshot, config, recent, now } = input;
  const candidates = [...new Map(input.candidates.map((c) => [c.id, c])).values()];
  const fallback = (): RecommendationOrder => {
    const visible = new Set(candidates.map((c) => c.id));
    const characterIds = [
      ...new Set([...(input.fallbackOrder ?? []), ...candidates.map((c) => c.id)]),
    ].filter((id) => visible.has(id));
    return {
      characterIds,
      headIds: characterIds.slice(0, LOBBY_ROTATION_HEAD_SIZE),
      degraded: true,
    };
  };
  if (!snapshot) return fallback();

  const scores = new Map(
    candidates.map((c) => [c.id, quality(snapshot.scores.get(c.id), snapshot.minSample, now)])
  );
  const reliable = candidates.filter((c) => (scores.get(c.id) ?? -1) >= RELIABLE_SCORE);
  const top = reliable.filter((c) => (scores.get(c.id) ?? 0) >= TOP_SCORE);
  // New/under-sampled cards may explore. A mature poor score is not an exploration opportunity.
  const explore = candidates.filter((c) => {
    const stat = snapshot.scores.get(c.id);
    return (
      c.canExplore &&
      scores.get(c.id) === null &&
      (!stat ||
        stat.sampleSize < snapshot.minSample ||
        (stat.trustedAt !== undefined &&
          now - stat.trustedAt > TRUSTED_MAX_AGE &&
          (stat.trustedScore ?? -1) >= RELIABLE_SCORE)) &&
      (!stat?.qualityVersion || stat.qualityVersion === QUALIFIED_QUALITY_VERSION)
    );
  });
  if (
    reliable.length < Math.min(4, candidates.length) ||
    reliable.length === 0 ||
    reliable.length + Math.min(config.exploration_count, explore.length) <
      Math.min(LOBBY_ROTATION_HEAD_SIZE, candidates.length)
  )
    return fallback();

  const rng = rngFrom(input.seed);
  const selected: RecommendationCandidate[] = [];
  const taken = new Set<string>();
  const last = new Set(recent[0]?.characterIds ?? []);
  const older = new Set(recent.slice(1, 3).flatMap((batch) => batch.characterIds));
  let repeated = 0;
  let relaxed = false;
  const weight = (candidate: RecommendationCandidate) => {
    const score = scores.get(candidate.id);
    const trusted = score !== null && score !== undefined;
    const tagMatches = selected.filter((other) =>
      candidate.tags.some((tag) => other.tags.includes(tag))
    ).length;
    return (
      ((trusted ? 0.5 + score / 100 : 1) *
        exposureWeight(input.exposures.get(candidate.id), now, trusted) *
        (older.has(candidate.id) ? 0.55 : 1)) /
      (1 + tagMatches * 0.45)
    );
  };
  const add = (candidate: RecommendationCandidate) => {
    taken.add(candidate.id);
    selected.push(candidate);
    if (last.has(candidate.id)) repeated += 1;
  };
  const draw = (pool: readonly RecommendationCandidate[]) => {
    if (pool.length === 0) return false;
    const weights = pool.map(weight);
    let pick = rng() * weights.reduce((sum, w) => sum + w, 0);
    for (let index = 0; index < pool.length; index += 1) {
      pick -= weights[index]!;
      if (pick <= 0 || index === pool.length - 1) {
        add(pool[index]!);
        return true;
      }
    }
    return false;
  };
  const choose = (preferred: readonly RecommendationCandidate[], backup = preferred) => {
    // Exhaust genuinely fresh reliable candidates before spending a repeat slot. This avoids
    // random early repeats making the 2-of-12 guarantee fail despite sufficient inventory.
    for (const pool of [preferred, backup]) {
      if (draw(pool.filter((c) => !taken.has(c.id) && !last.has(c.id)))) return true;
    }
    const remaining = backup.filter((c) => !taken.has(c.id));
    if (remaining.length === 0) return false;
    if (repeated >= config.max_repeat) relaxed = true;
    return draw(remaining);
  };
  while (selected.length < Math.min(4, reliable.length)) {
    if (!choose(top, reliable)) break;
  }
  const explorationCount = Math.min(config.exploration_count, explore.length);
  const reliableTarget = LOBBY_ROTATION_HEAD_SIZE - explorationCount;
  while (selected.length < reliableTarget) {
    if (!choose(reliable)) break;
  }
  for (
    let slot = 0;
    slot < explorationCount && selected.length < LOBBY_ROTATION_HEAD_SIZE;
    slot++
  ) {
    const freshExplore = explore.filter((c) => !taken.has(c.id) && !last.has(c.id));
    if (draw(freshExplore)) continue;
    // Do not spend a repeat on an exploration card if a fresh proven card can fill the slot.
    if (draw(reliable.filter((c) => !taken.has(c.id) && !last.has(c.id)))) continue;
    if (!choose(explore, [...explore, ...reliable])) break;
  }
  while (selected.length < LOBBY_ROTATION_HEAD_SIZE) {
    if (!choose(reliable)) break;
  }

  // The existing catalog order supplies the tail (including lower-quality/cold cards). Insufficient
  // quality inventory is reported, rather than labelling those tail cards as quality selections.
  const characterIds = [...selected, ...candidates.filter((c) => !taken.has(c.id))].map(
    (c) => c.id
  );
  return {
    characterIds,
    headIds: characterIds.slice(0, LOBBY_ROTATION_HEAD_SIZE),
    degraded:
      relaxed ||
      repeated > config.max_repeat ||
      selected.length < Math.min(LOBBY_ROTATION_HEAD_SIZE, candidates.length),
  };
}
