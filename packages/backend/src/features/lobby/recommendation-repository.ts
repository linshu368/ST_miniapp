import type { Prisma } from '@prisma/client';
import {
  LOBBY_ROTATION_HEAD_SIZE,
  LobbyRecommendationDataSchema,
  LobbyRecommendationHeadIdsSchema,
  LobbyRecommendationRequestSchema,
  type LobbyRecommendationData,
  type LobbyRecommendationExposures,
  type LobbyRecommendationRequest,
  type LobbyRotationConfig,
} from '@miniapp/shared';
import type { RecentRecommendationHead, RecommendationOrder } from './recommendation-ranking.js';
export { readLobbyHeadRows, type LobbyHeadRow } from './head-read.js';

export type RecommendationDbClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export interface RecommendationDatabase {
  $transaction<T>(
    run: (tx: RecommendationDbClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<T>;
}

interface StoredBatch {
  id: string;
  generatedAt: string;
  expiresAt: string;
  characterIds: string[];
  headIds: string[];
  degraded: boolean;
}
export interface RecommendationState {
  current: StoredBatch;
  previous: StoredBatch | null;
  undoUntil: string | null;
  recent: RecentRecommendationHead[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recommendation state');
  return value as Record<string, unknown>;
}
function parseBatch(value: unknown): StoredBatch {
  const batch = object(value);
  const parsed = LobbyRecommendationDataSchema.parse({
    enabled: true,
    degraded: batch.degraded,
    batch_id: batch.id,
    generated_at: batch.generatedAt,
    expires_at: batch.expiresAt,
    character_ids: batch.characterIds,
    head_ids: batch.headIds,
    previous_batch_id: null,
  });
  if (!parsed.batch_id || !parsed.generated_at || !parsed.expires_at)
    throw new Error('Incomplete recommendation batch');
  return {
    id: parsed.batch_id,
    generatedAt: parsed.generated_at,
    expiresAt: parsed.expires_at,
    characterIds: parsed.character_ids,
    headIds: parsed.head_ids,
    degraded: parsed.degraded,
  };
}
function parseState(value: unknown): RecommendationState {
  const state = object(value);
  if (
    !Array.isArray(state.recent) ||
    state.recent.length > 3 ||
    (state.undoUntil !== null &&
      (typeof state.undoUntil !== 'string' || !Number.isFinite(Date.parse(state.undoUntil))))
  ) {
    throw new Error('Invalid recommendation history');
  }
  return {
    current: parseBatch(state.current),
    previous: state.previous === null ? null : parseBatch(state.previous),
    undoUntil: state.undoUntil,
    recent: state.recent.map((entry) => {
      const batch = object(entry);
      return {
        id: LobbyRecommendationRequestSchema.shape.request_id.parse(batch.id),
        characterIds: LobbyRecommendationHeadIdsSchema.parse(batch.characterIds),
      };
    }),
  };
}

const TRANSACTION_OPTIONS = { timeout: 5000, maxWait: 1500 };
async function lock(tx: RecommendationDbClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`;
  // Database serialization covers first insertion and multiple Railway replicas, unlike a process map.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'lobby-recommendation:' + userId}, 0))::text`;
}
async function readState(tx: Pick<RecommendationDbClient, '$queryRaw'>, userId: string) {
  const rows = await tx.$queryRaw<Array<{ state: unknown }>>`
    SELECT state FROM miniapp_features.user_lobby_recommendations WHERE user_id = ${userId}::uuid
  `;
  return rows[0] ? parseState(rows[0].state) : null;
}

function visibleBatch(batch: StoredBatch, visibleIds: ReadonlySet<string>): StoredBatch {
  const characterIds = [...new Set(batch.characterIds)].filter((id) => visibleIds.has(id));
  return { ...batch, characterIds, headIds: characterIds.slice(0, LOBBY_ROTATION_HEAD_SIZE) };
}
function response(batch: StoredBatch, previousId: string | null): LobbyRecommendationData {
  return {
    enabled: true,
    degraded: batch.degraded,
    batch_id: batch.id,
    generated_at: batch.generatedAt,
    expires_at: batch.expiresAt,
    character_ids: batch.characterIds,
    head_ids: batch.headIds,
    previous_batch_id: previousId,
  };
}

// An existing open/resume is a point-in-time read. Mutations and a miss still go through
// the locked path, where state is read again before deciding whether to create a batch.
export async function readReusableRecommendation(
  db: Pick<RecommendationDbClient, '$queryRaw'>,
  userId: string,
  request: LobbyRecommendationRequest,
  now: Date
): Promise<LobbyRecommendationData | null> {
  if (request.action !== 'open' && request.action !== 'resume') return null;
  const state = await readState(db, userId);
  if (!state) return null;
  const { current, previous } = state;
  if (request.action === 'resume') {
    if (previous && previous.id === request.expected_batch_id) return response(previous, null);
    return response(current, previous?.id ?? null);
  }
  if (
    now.getTime() < Date.parse(current.expiresAt) ||
    state.recent.some((batch) => batch.id === request.request_id) ||
    (request.expected_batch_id && request.expected_batch_id !== current.id)
  ) {
    return response(current, previous?.id ?? null);
  }
  return null;
}

export interface UpdateRecommendationOptions {
  now: Date;
  config: LobbyRotationConfig;
  visibleIds: readonly string[];
  build: (
    exposures: ReadonlyMap<string, number>,
    recent: readonly RecentRecommendationHead[]
  ) => RecommendationOrder;
}

/** No external I/O runs while this transaction owns the user's short lock. */
export async function updateRecommendation(
  database: RecommendationDatabase,
  userId: string,
  request: LobbyRecommendationRequest,
  options: UpdateRecommendationOptions
): Promise<LobbyRecommendationData> {
  return database.$transaction(async (tx) => {
    await lock(tx, userId);
    const state = await readState(tx, userId);
    const visibleIds = new Set(options.visibleIds);
    const current = state ? visibleBatch(state.current, visibleIds) : null;
    const previous = state?.previous ? visibleBatch(state.previous, visibleIds) : null;
    const currentResponse = () => response(current!, previous?.id ?? null);

    if (state && current) {
      if (request.action === 'resume') {
        if (previous && previous.id === request.expected_batch_id) return response(previous, null);
        return currentResponse();
      }
      // Late retries of a successful refresh must not consume another batch, including after undo.
      if (state.recent.some((batch) => batch.id === request.request_id)) return currentResponse();
      if (request.action === 'undo') {
        if (
          request.expected_batch_id !== current.id ||
          request.restore_batch_id !== previous?.id ||
          !previous ||
          !state.undoUntil ||
          options.now.getTime() > Date.parse(state.undoUntil)
        )
          return currentResponse();
        const restored: RecommendationState = {
          ...state,
          current: previous,
          previous: current,
          undoUntil: null,
        };
        await saveState(tx, userId, restored, options.now);
        return response(previous, null);
      }
      // Existing refresh requires a compare-and-swap precondition, including absent/null values.
      if (request.action === 'refresh' && request.expected_batch_id !== current.id)
        return currentResponse();
      if (request.action === 'open' && options.now.getTime() < Date.parse(current.expiresAt))
        return currentResponse();
      // A late open from another document should not rotate a freshly generated current batch.
      if (
        request.action === 'open' &&
        request.expected_batch_id &&
        request.expected_batch_id !== current.id
      )
        return currentResponse();
    }

    const exposureRows = await tx.$queryRaw<Array<{ character_id: string; last_seen_at: Date }>>`
      SELECT character_id, last_seen_at FROM miniapp_features.user_character_exposures
      WHERE user_id = ${userId}::uuid
    `;
    const recent = state
      ? [
          { id: state.current.id, characterIds: state.current.headIds },
          ...state.recent.filter((b) => b.id !== state.current.id),
        ].slice(0, 3)
      : [];
    const order = options.build(
      new Map(exposureRows.map((row) => [row.character_id, new Date(row.last_seen_at).getTime()])),
      recent
    );
    const next: StoredBatch = {
      id: request.request_id,
      generatedAt: options.now.toISOString(),
      expiresAt: new Date(
        options.now.getTime() + options.config.interval_hours * 3_600_000
      ).toISOString(),
      ...order,
    };
    const nextState: RecommendationState = {
      current: next,
      previous: current,
      undoUntil: current ? new Date(options.now.getTime() + 30_000).toISOString() : null,
      recent: [{ id: next.id, characterIds: next.headIds }, ...recent].slice(0, 3),
    };
    await saveState(tx, userId, nextState, options.now);
    return response(next, current?.id ?? null);
  }, TRANSACTION_OPTIONS);
}

async function saveState(
  tx: RecommendationDbClient,
  userId: string,
  state: RecommendationState,
  now: Date
) {
  const valid = parseState(state);
  await tx.$executeRaw`
    INSERT INTO miniapp_features.user_lobby_recommendations(user_id, state, updated_at)
    VALUES (${userId}::uuid, ${JSON.stringify(valid)}::jsonb, ${now}::timestamptz)
    ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
  `;
}

export async function recordRecommendationExposures(
  database: RecommendationDatabase,
  userId: string,
  request: LobbyRecommendationExposures,
  visibleIds: readonly string[],
  now: Date
): Promise<number> {
  return database.$transaction(async (tx) => {
    await lock(tx, userId);
    const state = await readState(tx, userId);
    const batch = [state?.current, state?.previous].find(
      (candidate) => candidate?.id === request.batch_id
    );
    if (!batch) return 0;
    const visible = new Set(visibleIds);
    const belonging = new Set(batch.characterIds);
    const ids = [...new Set(request.character_ids)].filter(
      (id) => visible.has(id) && belonging.has(id)
    );
    if (!ids.length) return 0;
    // A short batch-id ring prevents retry/undo from repeatedly extending the exposure penalty.
    return tx.$executeRaw`
      INSERT INTO miniapp_features.user_character_exposures(user_id, character_id, last_seen_at, seen_batch_ids)
      SELECT ${userId}::uuid, t.id::uuid, ${now}::timestamptz, ARRAY[${request.batch_id}::uuid]
      FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS t(id)
      ON CONFLICT (user_id, character_id) DO UPDATE SET
        last_seen_at = GREATEST(miniapp_features.user_character_exposures.last_seen_at, EXCLUDED.last_seen_at),
        seen_batch_ids = (EXCLUDED.seen_batch_ids || miniapp_features.user_character_exposures.seen_batch_ids)[1:3]
      WHERE NOT (${request.batch_id}::uuid = ANY(miniapp_features.user_character_exposures.seen_batch_ids))
    `;
  }, TRANSACTION_OPTIONS);
}
