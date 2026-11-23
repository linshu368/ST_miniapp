/**
 * 运营「保上」：这个模型不再被自动下架，一直上着（质量越线、报价不达标、真实请求派不出去都不动，
 * 见 lifecycle.ts）。点保上时没在架就顺手上架；上不了（报价、探测都不行）也保留标记，
 * 之后每 30 分钟评估初筛一通过就自动上架。取消保上只去掉标记，在架状态不变。
 */
import type { AdminFreeZonePinResponse, FreeZoneConfig } from '@miniapp/shared';
import { fetchFreeZoneConfig } from './config.js';
import { FreeZoneListNowError, listFreeZoneModelNow } from './manual-list.js';
import { savePinned } from './repository.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';

export interface PinDeps {
  loadConfig: () => Promise<FreeZoneConfig>;
  save: typeof savePinned;
  listNow: typeof listFreeZoneModelNow;
}

const defaultDeps: PinDeps = {
  loadConfig: fetchFreeZoneConfig,
  save: savePinned,
  listNow: listFreeZoneModelNow,
};

export async function pinFreeZoneModel(
  input: { candidateId: string; pinned: boolean },
  deps: PinDeps = defaultDeps
): Promise<AdminFreeZonePinResponse> {
  const config = await deps.loadConfig();
  const candidate = config.candidates.find((item) => item.id === input.candidateId);
  if (!candidate) {
    throw new FreeZoneListNowError(404, `已发布的候选池里没有 ${input.candidateId}`);
  }
  const state = await deps.save({
    candidateId: candidate.id,
    surplusModel: candidate.surplus_model,
    pinned: input.pinned,
  });
  let listed = state.status === 'listed';
  let note: string | null = null;
  if (input.pinned && !listed) {
    try {
      await deps.listNow({ candidateId: candidate.id });
      listed = true;
    } catch (err) {
      if (!(err instanceof FreeZoneListNowError)) throw err;
      note = `没能马上上架：${err.message}。已保上，初筛通过会自动上架`;
    }
  }
  invalidateFreeZoneSnapshot();
  return {
    candidate_id: candidate.id,
    display_name: candidate.display_name,
    pinned: input.pinned,
    listed,
    note,
  };
}
