import type { RankingDbClient } from './ranking-stats.js';

/** A session with 21 or more logical turns counts once. */
export const DEEP_EXPERIENCE_MIN_TURNS = 20;

export interface DeepExperienceStat {
  characterId: string;
  deepSessionCount: number;
}

interface DeepExperienceRow {
  character_id: string;
  deep_session_count: bigint | number;
}

/**
 * Compute the cumulative per-card snapshot off the request path.
 * Revisions are collapsed before the 30-minute session split so regenerating a
 * reply cannot manufacture extra turns.
 */
export async function computeDeepExperienceStats(
  db: RankingDbClient
): Promise<DeepExperienceStat[]> {
  const rows = await db.$queryRaw<DeepExperienceRow[]>`
    WITH structured_turns AS (
      SELECT
        character_id,
        user_id,
        session_id,
        turn_index,
        MIN(created_at) AS first_at,
        session_id::text || ':' || turn_index::text AS event_key
      FROM experience.chat_history
      WHERE character_id IS NOT NULL
        AND session_id IS NOT NULL
        AND turn_index IS NOT NULL
      GROUP BY character_id, user_id, session_id, turn_index
    ),
    legacy_turns AS (
      SELECT
        character_id,
        user_id,
        created_at AS first_at,
        id::text AS event_key
      FROM experience.chat_history
      WHERE character_id IS NOT NULL
        AND (session_id IS NULL OR turn_index IS NULL)
    ),
    turn_events AS (
      SELECT character_id, user_id, first_at, event_key FROM structured_turns
      UNION ALL
      SELECT character_id, user_id, first_at, event_key FROM legacy_turns
    ),
    gapped AS (
      SELECT
        character_id,
        user_id,
        first_at,
        event_key,
        LAG(first_at) OVER (
          PARTITION BY character_id, user_id
          ORDER BY first_at, event_key
        ) AS previous_at
      FROM turn_events
    ),
    sessionized AS (
      SELECT
        character_id,
        user_id,
        SUM(
          CASE
            WHEN previous_at IS NULL
              OR first_at - previous_at > INTERVAL '30 minutes'
            THEN 1 ELSE 0
          END
        ) OVER (
          PARTITION BY character_id, user_id
          ORDER BY first_at, event_key
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS session_no
      FROM gapped
    ),
    session_counts AS (
      SELECT character_id, user_id, session_no, COUNT(*)::int AS rounds
      FROM sessionized
      GROUP BY character_id, user_id, session_no
    )
    SELECT
      character_id,
      COUNT(*) FILTER (WHERE rounds > ${DEEP_EXPERIENCE_MIN_TURNS}::int)::bigint
        AS deep_session_count
    FROM session_counts
    GROUP BY character_id
  `;

  return rows.map((row) => ({
    characterId: row.character_id,
    deepSessionCount: Number(row.deep_session_count),
  }));
}

/** Overwrite the derived snapshot atomically from one completed aggregate. */
export async function persistDeepExperienceStats(
  db: RankingDbClient,
  stats: readonly DeepExperienceStat[]
): Promise<void> {
  if (stats.length === 0) return;

  const payload = JSON.stringify(
    stats.map((row) => ({
      character_id: row.characterId,
      deep_session_count: row.deepSessionCount,
    }))
  );

  await db.$executeRaw`
    INSERT INTO features.character_deep_experience_stats
      (character_id, deep_session_count, computed_at)
    SELECT character_id, deep_session_count, clock_timestamp()
    FROM jsonb_to_recordset(${payload}::jsonb) AS t(
      character_id uuid,
      deep_session_count bigint
    )
    WHERE deep_session_count >= 0
      AND EXISTS (
        SELECT 1 FROM app_core.characters c WHERE c.id = t.character_id
      )
    ON CONFLICT (character_id) DO UPDATE SET
      deep_session_count = EXCLUDED.deep_session_count,
      computed_at = EXCLUDED.computed_at
  `;

  await db.$executeRaw`
    DELETE FROM features.character_deep_experience_stats AS target
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(${payload}::jsonb) AS t(character_id uuid)
      WHERE t.character_id = target.character_id
    )
  `;
}
