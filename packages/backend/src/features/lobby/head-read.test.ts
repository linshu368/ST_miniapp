import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { readLobbyHeadRows } from './head-read.js';

const id = '10000000-0000-4000-8000-000000000001';
const card = {
  id,
  name: 'Synthetic',
  description: 'Complete text '.repeat(1000),
  avatar_url: '',
  tags: ['one', 'two', 'three'],
  creator: 'Synthetic',
};
const row = (fingerprint: string, payload: unknown) => [
  { id, fingerprint: fingerprint.repeat(64), payload },
];
function reader() {
  const query = vi.fn();
  return { db: { $queryRaw: query } as unknown as Pick<PrismaClient, '$queryRaw'>, query };
}

describe('conditional public head reads', () => {
  it('keeps complete descriptions/tags and still asks the DB on every unchanged read', async () => {
    const { db, query } = reader();
    query.mockResolvedValueOnce(row('a', card)).mockResolvedValueOnce(row('a', null));
    expect(await readLobbyHeadRows(db, [id])).toEqual([card]);
    expect(await readLobbyHeadRows(db, [id])).toEqual([card]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.parse(query.mock.calls[1]?.[3])).toEqual({ [id]: 'a'.repeat(64) });
  });

  it('does not return cached cards excluded by the authoritative visibility query', async () => {
    const { db, query } = reader();
    query.mockResolvedValueOnce(row('a', card)).mockResolvedValueOnce([]);
    await readLobbyHeadRows(db, [id]);
    expect(await readLobbyHeadRows(db, [id])).toEqual([]);
  });

  it('matches a concurrent response against its dispatch snapshot despite another update', async () => {
    const { db, query } = reader();
    query.mockResolvedValueOnce(row('a', card));
    await readLobbyHeadRows(db, [id]);
    let finish: ((value: unknown[]) => void) | undefined;
    query.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          finish = resolve;
        })
    );
    const pending = readLobbyHeadRows(db, [id]);
    const changed = { ...card, description: 'New complete text' };
    query.mockResolvedValueOnce(row('b', changed));
    expect(await readLobbyHeadRows(db, [id])).toEqual([changed]);
    finish?.(row('a', null));
    expect(await pending).toEqual([card]);
  });

  it('fails closed for missing payload, mismatched identity and DB failure', async () => {
    const { db, query } = reader();
    query.mockResolvedValueOnce(row('a', null));
    await expect(readLobbyHeadRows(db, [id])).rejects.toThrow('snapshot');
    query.mockResolvedValueOnce(row('a', { ...card, id: '10000000-0000-4000-8000-000000000002' }));
    await expect(readLobbyHeadRows(db, [id])).rejects.toThrow('identity');
    query.mockRejectedValueOnce(new Error('timeout'));
    await expect(readLobbyHeadRows(db, [id])).rejects.toThrow('timeout');
  });

  it('does not retain an oversized card, but still delivers its full body', async () => {
    const { db, query } = reader();
    const large = { ...card, description: 'x'.repeat(2 * 1024 * 1024 + 1) };
    query.mockResolvedValueOnce(row('a', large)).mockResolvedValueOnce(row('a', large));
    expect((await readLobbyHeadRows(db, [id]))[0]?.description).toHaveLength(
      large.description.length
    );
    await readLobbyHeadRows(db, [id]);
    expect(JSON.parse(query.mock.calls[1]?.[3])).toEqual({});
  });
});
