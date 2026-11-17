import type { PrismaClient } from '@prisma/client';
import { LOBBY_ROTATION_HEAD_SIZE } from '@miniapp/shared';
import { z } from 'zod';
import { readWithinBudget } from './catalog-read.js';

type Reader = Pick<PrismaClient, '$queryRaw'>;
const cardSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  avatar_url: z.string(),
  tags: z.unknown(),
  creator: z.string(),
});
export type LobbyHeadRow = z.infer<typeof cardSchema>;
const responseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    payload: z.unknown(),
  })
);
type CachedCard = { fingerprint: string; value: LobbyHeadRow; bytes: number };
type Cache = { cards: Map<string, CachedCard>; bytes: number };
const caches = new WeakMap<Reader, Cache>();
const MAX_CARDS = 256;
const MAX_BYTES = 2 * 1024 * 1024;

function remember(cache: Cache, row: CachedCard): void {
  const previous = cache.cards.get(row.value.id);
  if (previous) {
    cache.bytes -= previous.bytes;
    cache.cards.delete(row.value.id);
  }
  if (row.bytes > MAX_BYTES) return;
  cache.cards.set(row.value.id, row);
  cache.bytes += row.bytes;
  while (cache.cards.size > MAX_CARDS || cache.bytes > MAX_BYTES) {
    const oldest = cache.cards.entries().next().value;
    if (!oldest) break;
    cache.bytes -= oldest[1].bytes;
    cache.cards.delete(oldest[0]);
  }
}

/** Every read checks visibility and full content in one DB snapshot. The cache saves bytes,
 * never permission checks, freshness checks or the full description used by consumers.
 */
export async function readLobbyHeadRows(db: Reader, orderedIds: string[]): Promise<LobbyHeadRow[]> {
  if (!orderedIds.length) return [];
  let cache = caches.get(db);
  if (!cache) {
    cache = { cards: new Map(), bytes: 0 };
    caches.set(db, cache);
  }
  // Capture references before awaiting: concurrent requests may evict or replace the shared cache.
  const captured = new Map(
    orderedIds.slice(0, LOBBY_ROTATION_HEAD_SIZE).flatMap((id) => {
      const card = cache.cards.get(id);
      return card ? [[id, card] as const] : [];
    })
  );
  const known = Object.fromEntries([...captured].map(([id, card]) => [id, card.fingerprint]));
  const rows = await readWithinBudget(db.$queryRaw<unknown[]>`
    WITH heads AS MATERIALIZED (
      SELECT c.id,b.position,jsonb_build_object('id',c.id,'name',c.name,'description',c.description,
        'avatar_url',c.avatar_url,'tags',c.tags,'creator',c.creator) AS payload
      FROM jsonb_array_elements_text(${JSON.stringify(orderedIds)}::jsonb) WITH ORDINALITY AS b(id,position)
      JOIN app_core.characters c ON c.id=b.id::uuid
      WHERE NOT c.is_test AND app_core.can_discover_character(c.id)
      ORDER BY b.position LIMIT ${LOBBY_ROTATION_HEAD_SIZE}
    ), snapshots AS MATERIALIZED (
      SELECT id,position,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS fingerprint FROM heads
    ) SELECT id,fingerprint,CASE WHEN fingerprint=(${JSON.stringify(known)}::jsonb ->> id::text)
        THEN NULL ELSE payload END AS payload FROM snapshots ORDER BY position
  `);
  const cards = responseSchema.parse(rows).map((row): CachedCard => {
    if (row.payload === null) {
      const previous = captured.get(row.id);
      if (!previous || previous.fingerprint !== row.fingerprint)
        throw new Error('Lobby head conditional response does not match its snapshot');
      return previous;
    }
    const value = cardSchema.parse(row.payload);
    if (value.id !== row.id) throw new Error('Lobby head identity mismatch');
    return { fingerprint: row.fingerprint, value, bytes: Buffer.byteLength(JSON.stringify(value)) };
  });
  for (const card of cards) remember(cache, card);
  return cards.map((card) => card.value);
}
