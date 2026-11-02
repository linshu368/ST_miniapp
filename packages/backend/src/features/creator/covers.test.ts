import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
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
