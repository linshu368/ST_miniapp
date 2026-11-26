/**
 * 运营「保上」：在架期间不再自动下架（连续拒单只记日志，见 unroutable-guard.ts）。
 * 点保上时没在架就顺手按「上架」的默认规则上架；上不了也保留标记，之后手动上架即生效。
 * 取消保上只去掉标记，在架状态不变；运营手动下架会同时取消保上（lifecycle.delistManually）。
 */
import type { AdminFreeZonePinResponse, FreeZoneConfig } from '@miniapp/shared';
import { fetchFreeZoneConfig } from './config.js';
import { FreeZoneListNowError, listFreeZoneModelNow } from './manual-list.js';
import { savePinned } from './repository.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';

export interface PinDeps {
  loadConfig: () => Promise<FreeZoneConfig>;
  save: typeof savePinned;
  listNow: (input: { candidateId: string }) => Promise<unknown>;
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
      note = `没能马上上架：${err.message}。保上标记已保留，手动上架后生效`;
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
