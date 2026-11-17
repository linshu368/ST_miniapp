import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { readFeaturedCatalog, readRecommendationCatalog } from './catalog-read.js';

const id = '10000000-0000-4000-8000-000000000001';
function reader(...responses: unknown[][]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { db: { $queryRaw: query } as unknown as Pick<PrismaClient, '$queryRaw'>, query };
}

describe('conditional lobby projection contract', () => {
  it('retains every tag and candidate, then reuses only a matching unchanged snapshot', async () => {
    const { db, query } = reader(
      [
        {
          fingerprint: 'a'.repeat(64),
          payload: [{ id, tags: ['one', 'two', 'three'], can_explore: true }],
        },
      ],
      [{ fingerprint: 'a'.repeat(64), payload: null }]
    );
    const first = await readRecommendationCatalog(db, null);
    expect(first.value).toEqual([{ id, tags: ['one', 'two', 'three'], canExplore: true }]);
    expect(await readRecommendationCatalog(db, first)).toBe(first);
    expect(query.mock.calls[1]?.[1]).toBe(first.fingerprint);
  });

  it('applies an authoritative empty projection after unlisting instead of keeping stale cards', async () => {
    const { db } = reader([{ fingerprint: 'b'.repeat(64), payload: [] }]);
    const next = await readFeaturedCatalog(db, { fingerprint: 'a'.repeat(64), value: [{ id }] });
    expect(next.value).toEqual([]);
    expect(next.fingerprint).toBe('b'.repeat(64));
  });

  it.each(
    [
      [],
      [{ fingerprint: 'a'.repeat(64), payload: null }],
      [{ fingerprint: 'b'.repeat(64), payload: null }],
      [{ fingerprint: 'invalid', payload: [] }],
      [{ fingerprint: 'b'.repeat(64), payload: [{ id: 'invalid' }] }],
    ].map((rows) => ({ rows }))
  )(
    'rejects missing, mismatched or corrupt snapshots without returning invented empty data',
    async ({ rows }) => {
      const { db } = reader(rows);
      await expect(readFeaturedCatalog(db, null)).rejects.toThrow();
    }
  );

  it('does not mutate the previous snapshot when revalidation fails', async () => {
    const previous = { fingerprint: 'a'.repeat(64), value: [{ id }] };
    const { db, query } = reader();
    query.mockRejectedValue(new Error('timeout'));
    await expect(readFeaturedCatalog(db, previous)).rejects.toThrow('timeout');
    expect(previous.value).toEqual([{ id }]);
  });
});
