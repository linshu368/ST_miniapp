import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { RecommendationCandidate } from './recommendation-ranking.js';

type Reader = Pick<PrismaClient, '$queryRaw'>;
export interface CatalogSnapshot<T> {
  fingerprint: string;
  value: T[];
}
const envelope = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(),
});
const candidateRows = z.array(
  z.object({
    id: z.string().uuid(),
    tags: z.unknown(),
    can_explore: z.boolean().nullable(),
  })
);
const featuredRows = z.array(z.object({ id: z.string().uuid() }));

/** Bound the caller's wait without retrying; a late driver result cannot refresh the cache. */
export async function readWithinBudget<T>(query: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Lobby database read deadline exceeded')), 12000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readSnapshot<T>(
  rows: unknown[],
  previous: CatalogSnapshot<T> | null,
  decode: (payload: unknown) => T[]
): CatalogSnapshot<T> {
  if (rows.length !== 1) throw new Error('Lobby catalog snapshot is missing');
  const row = envelope.parse(rows[0]);
  if (row.payload === null) {
    // A missing payload is an explicit conditional response, never an empty catalog.
    if (!previous || previous.fingerprint !== row.fingerprint)
      throw new Error('Lobby catalog conditional response does not match its snapshot');
    return previous;
  }
  return { fingerprint: row.fingerprint, value: decode(row.payload) };
}

/** Revalidate the exact projection in PostgreSQL; transfer it only when it changed.
 * The caller retains its existing TTL/single-flight and owns this snapshot. No updated_at assumption.
 */
export async function readRecommendationCatalog(
  db: Reader,
  previous: CatalogSnapshot<RecommendationCandidate> | null
): Promise<CatalogSnapshot<RecommendationCandidate>> {
  const rows = await readWithinBudget(db.$queryRaw<unknown[]>`
    WITH cards AS MATERIALIZED (
      SELECT c.id,c.tags,(c.name ~ '[^[:space:]]' AND c.description ~ '[^[:space:]]') AS can_explore,
        c.sort_order,c.created_at
      FROM app_core.characters c
      WHERE NOT c.is_test AND app_core.can_discover_character(c.id)
      ORDER BY c.sort_order ASC,c.created_at DESC LIMIT 10000
    ), document AS MATERIALIZED (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'tags',tags,'can_explore',can_explore)
        ORDER BY sort_order ASC,created_at DESC),'[]'::jsonb) AS payload FROM cards
    ), snapshot AS MATERIALIZED (
      SELECT payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS fingerprint FROM document
    ) SELECT fingerprint,CASE WHEN fingerprint=${previous?.fingerprint ?? null} THEN NULL ELSE payload END AS payload
      FROM snapshot
  `);
  return readSnapshot(rows, previous, (payload) =>
    candidateRows.parse(payload).map((row) => ({
      id: row.id,
      tags: Array.isArray(row.tags)
        ? row.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      canExplore: row.can_explore === true,
    }))
  );
}

/** Featured eligibility uses the original uncapped visible set, independently of recommendation limits. */
export async function readFeaturedCatalog(
  db: Reader,
  previous: CatalogSnapshot<{ id: string }> | null
): Promise<CatalogSnapshot<{ id: string }>> {
  const rows = await readWithinBudget(db.$queryRaw<unknown[]>`
    WITH document AS MATERIALIZED (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id)
        ORDER BY c.sort_order ASC,c.created_at DESC),'[]'::jsonb) AS payload
      FROM app_core.characters c
      WHERE c.enabled AND c.archived_at IS NULL AND (
        NOT EXISTS(SELECT 1 FROM app_core.character_creations cr WHERE cr.character_id=c.id)
        OR EXISTS(SELECT 1 FROM app_core.character_creations cr WHERE cr.character_id=c.id
          AND cr.state='ready' AND cr.visibility='public' AND cr.approved_revision IS NOT NULL))
    ), snapshot AS MATERIALIZED (
      SELECT payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS fingerprint FROM document
    ) SELECT fingerprint,CASE WHEN fingerprint=${previous?.fingerprint ?? null} THEN NULL ELSE payload END AS payload
      FROM snapshot
  `);
  return readSnapshot(rows, previous, (payload) => featuredRows.parse(payload));
}
