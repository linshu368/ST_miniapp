import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  creatorRewardSnapshot,
  getCharacterCreatorOwner,
  readCreatorRewardSnapshot,
} from './creator-billing.js';
import { frozenLlmChargeMetadata } from './text-billing.js';

const { result, from, select, eq } = vi.hoisted(() => {
  const result = vi.fn();
  const eq = vi.fn(() => ({ abortSignal: () => ({ maybeSingle: result }) }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { result, from, select, eq };
});
vi.mock('../../lib/supabase.js', () => ({ getDomainDb: () => ({ from }) }));
const characterId = '90000000-0000-4000-8000-000000000010';
const creatorId = '90000000-0000-4000-8000-000000000002';

beforeEach(() => {
  vi.clearAllMocks();
  result.mockResolvedValue({ data: null, error: null });
});

describe('creator billing identity', () => {
  it('leaves official cards unchanged and uses only durable owner identity', async () => {
    expect(await getCharacterCreatorOwner(null)).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(await getCharacterCreatorOwner(characterId)).toBeNull();
    result.mockResolvedValue({ data: { owner_user_id: creatorId }, error: null });
    expect(await getCharacterCreatorOwner(characterId)).toBe(creatorId);
    expect(from).toHaveBeenLastCalledWith('character_creations');
    expect(select).toHaveBeenLastCalledWith('owner_user_id');
    expect(eq).toHaveBeenLastCalledWith('character_id', characterId);
  });
  it('does not silently skip rewards or discounts when the schema/database lookup fails', async () => {
    result.mockResolvedValue({ data: null, error: { code: '42P01' } });
    await expect(getCharacterCreatorOwner(characterId)).rejects.toThrow('Unable to resolve');
  });
  it('carries the fixed accepted reward rule unchanged through charge metadata', () => {
    const accepted = creatorRewardSnapshot(characterId, creatorId);
    const recovered = readCreatorRewardSnapshot(JSON.parse(JSON.stringify(accepted)));
    expect(recovered).toEqual({
      character_id: characterId,
      creator_user_id: creatorId,
      rate: 0.4,
      wallet: 'bonus',
      policy_version: 1,
    });
    expect(
      frozenLlmChargeMetadata({
        fixed_deduction: 0,
        fixed_deduction_category: 'free_quota',
        creator_reward: recovered,
      }).creator_reward
    ).toEqual(accepted);
    expect(readCreatorRewardSnapshot(undefined)).toBeUndefined();
  });
  it('fails closed instead of silently dropping malformed frozen money facts', () => {
    const accepted = creatorRewardSnapshot(characterId, creatorId);
    expect(() => readCreatorRewardSnapshot({ ...accepted, wallet: 'main' })).toThrow();
    expect(() => readCreatorRewardSnapshot({ ...accepted, rate: 0.9 })).toThrow();
    expect(() => readCreatorRewardSnapshot({ ...accepted, creator_user_id: null })).toThrow();
  });
});
