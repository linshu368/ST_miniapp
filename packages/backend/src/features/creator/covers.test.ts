import type { FastifyBaseLogger } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    abortSignal: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.abortSignal.mockReturnValue(query);
  return { query, from: vi.fn().mockReturnValue(query), storage: vi.fn(), download: vi.fn() };
});
vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({ from: mocks.from }),
  getSupabaseClient: () => ({ storage: { from: mocks.storage } }),
}));
vi.mock('../image-plaza/storage.js', () => ({
  downloadPlazaImage: mocks.download,
  validatePlazaImage: vi.fn(),
}));
import {
  assertCreatorCoverAssetOwned,
  createCreatorCoverAsset,
  getCreatorCoverAsset,
  resolvePublicCreatorCoverUrls,
} from './covers.js';

beforeEach(() => {
  mocks.query.maybeSingle.mockReset();
  mocks.query.eq.mockClear();
  mocks.storage.mockClear();
  mocks.download.mockClear();
});
describe('private creator cover authorization', () => {
  it('never signs an asset belonging to another user', async () => {
    mocks.query.maybeSingle.mockResolvedValue({
      data: { id: 'cover', owner_user_id: 'someone-else' },
      error: null,
    });
    await expect(getCreatorCoverAsset('cover', 'viewer')).rejects.toThrow('not_found');
    await expect(assertCreatorCoverAssetOwned('cover', 'viewer')).rejects.toThrow('not_found');
    expect(mocks.storage).not.toHaveBeenCalled();
  });
  it('checks the owning generation before reading the generated image', async () => {
    mocks.query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { attempt_id: 'attempt', storage_path: 'owned-image' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(
      createCreatorCoverAsset(
        { id: 'cover', source: 'artifact', artifact_id: 'artifact' },
        'viewer'
      )
    ).rejects.toThrow('not_found');
    expect(mocks.query.eq).toHaveBeenCalledWith('user_id', 'viewer');
    expect(mocks.query.eq).toHaveBeenCalledWith('status', 'ready');
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('does not overwrite another author asset through an idempotency collision', async () => {
    mocks.query.maybeSingle.mockResolvedValue({
      data: { id: 'cover', owner_user_id: 'someone-else' },
      error: null,
    });
    await expect(
      createCreatorCoverAsset(
        { id: 'cover', source: 'artifact', artifact_id: 'artifact' },
        'viewer'
      )
    ).rejects.toThrow('not_found');
    expect(mocks.storage).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

it('batch signs uncached public covers once, matches by path and reuses valid signatures', async () => {
  const ids = Array.from(
    { length: 12 },
    (_, i) => '70000000-0000-4000-8000-' + String(i + 1).padStart(12, '0')
  );
  const assets = ids.map((id, i) => ({ id, storage_path: 'p/' + i }));
  mocks.query.abortSignal.mockResolvedValueOnce({ data: assets, error: null });
  const createSignedUrls = vi.fn().mockResolvedValue({
    error: null,
    data: [...assets]
      .reverse()
      .map((a) => ({ path: a.storage_path, signedUrl: 'signed/' + a.id, error: null })),
  });
  mocks.storage.mockReturnValue({ createSignedUrls });
  const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;
  const cold = await resolvePublicCreatorCoverUrls([...ids, ids[0]!], log);
  const hot = await resolvePublicCreatorCoverUrls(ids, log);
  expect([...cold].sort()).toEqual(ids.map((id) => [id, 'signed/' + id]));
  expect([...hot].sort()).toEqual([...cold].sort());
  expect(mocks.query.in).toHaveBeenCalledTimes(1);
  expect(createSignedUrls).toHaveBeenCalledTimes(1);
  expect(createSignedUrls).toHaveBeenCalledWith(
    assets.map((a) => a.storage_path),
    3600
  );
  mocks.query.abortSignal.mockResolvedValueOnce({ data: null, error: new Error('unavailable') });
  const mixed = await resolvePublicCreatorCoverUrls(
    [ids[0]!, '70000000-0000-4000-8000-000000000099'],
    log
  );
  expect([...mixed]).toEqual([[ids[0], 'signed/' + ids[0]]]);
});
