import { describe, expect, it, vi } from 'vitest';
import { FreeZoneConfigSchema } from '@miniapp/shared';
import { initialState, type FreeZoneModelState } from './lifecycle.js';
import { FreeZoneListNowError } from './manual-list.js';
import { pinFreeZoneModel, type PinDeps } from './manual-pin.js';

vi.mock('./snapshot.js', () => ({ invalidateFreeZoneSnapshot: vi.fn() }));

const config = FreeZoneConfigSchema.parse({
  candidates: [
    {
      id: 'free-deepseek-v4-1-flash-1017',
      surplus_model: 'deepseek-v4.1-flash-1017',
      display_name: 'DeepSeek V4.1 Flash 1017',
      family: 'deepseek',
      benchmark_tier: 'light',
    },
  ],
});

function deps(state: Partial<FreeZoneModelState>, listNow: PinDeps['listNow']) {
  const save = vi.fn(async (input: { candidateId: string; pinned: boolean }) => ({
    ...initialState(input.candidateId),
    ...state,
    pinned: input.pinned,
  }));
  return { loadConfig: async () => config, save, listNow: vi.fn(listNow) };
}

const id = 'free-deepseek-v4-1-flash-1017';

describe('pinFreeZoneModel', () => {
  it('pins a listed model without touching its listing', async () => {
    const d = deps({ status: 'listed', providers: ['mistral'] }, async () => undefined);
    const result = await pinFreeZoneModel({ candidateId: id, pinned: true }, d);
    expect(result).toMatchObject({ pinned: true, listed: true, note: null });
    expect(d.listNow).not.toHaveBeenCalled();
  });

  it('lists an unlisted model right away when pinning it', async () => {
    const d = deps({ status: 'unlisted' }, async () => undefined);
    const result = await pinFreeZoneModel({ candidateId: id, pinned: true }, d);
    expect(d.listNow).toHaveBeenCalledWith({ candidateId: id });
    expect(result).toMatchObject({ pinned: true, listed: true, note: null });
  });

  it('keeps the pin and explains when the model cannot be listed now', async () => {
    const d = deps({ status: 'unlisted' }, async () => {
      throw new FreeZoneListNowError(409, '没有达到折扣底线的供应商');
    });
    const result = await pinFreeZoneModel({ candidateId: id, pinned: true }, d);
    expect(result.pinned).toBe(true);
    expect(result.listed).toBe(false);
    expect(result.note).toContain('没有达到折扣底线的供应商');
  });

  it('unpinning only clears the flag', async () => {
    const d = deps({ status: 'unlisted' }, async () => undefined);
    const result = await pinFreeZoneModel({ candidateId: id, pinned: false }, d);
    expect(result).toMatchObject({ pinned: false, listed: false, note: null });
    expect(d.listNow).not.toHaveBeenCalled();
  });

  it('refuses a model outside the published pool', async () => {
    const d = deps({}, async () => undefined);
    await expect(pinFreeZoneModel({ candidateId: 'free-nope', pinned: true }, d)).rejects.toThrow(
      FreeZoneListNowError
    );
    expect(d.save).not.toHaveBeenCalled();
  });
});
