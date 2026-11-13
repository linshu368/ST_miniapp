/**
 * 运营手动「下架」一个在架的畅聊模型：立即对用户不可见，正在用它的用户下一轮自动换成别的免费模型
 * （和自动下架同一套换模型规则）。下架后一直停着，评估任务不会自动加回来；要用时走「立即上架」。
 */
import type { AdminFreeZoneDelistNowResponse, FreeZoneConfig } from '@miniapp/shared';
import { fetchFreeZoneConfig } from './config.js';
import { delistManually } from './lifecycle.js';
import { FreeZoneListNowError } from './manual-list.js';
import { saveManualDelisting, type ManualDelistingOutcome } from './repository.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';

export interface DelistNowDeps {
  loadConfig: () => Promise<FreeZoneConfig>;
  save: typeof saveManualDelisting;
}

const defaultDeps: DelistNowDeps = {
  loadConfig: fetchFreeZoneConfig,
  save: saveManualDelisting,
};

export async function delistFreeZoneModelNow(
  input: { candidateId: string },
  deps: DelistNowDeps = defaultDeps
): Promise<AdminFreeZoneDelistNowResponse> {
  const config = await deps.loadConfig();
  // 不要求在候选池里：移出候选池后仍停在在架状态的行也要能收掉
  const candidate = config.candidates.find((item) => item.id === input.candidateId);
  const name = candidate?.display_name ?? input.candidateId;
  const outcome: ManualDelistingOutcome = await deps.save({
    candidateId: input.candidateId,
    build: (current) => delistManually({ state: current }),
  });
  if (outcome.kind === 'not_listed') {
    throw new FreeZoneListNowError(409, `${name} 现在不在架`);
  }
  invalidateFreeZoneSnapshot();
  return {
    candidate_id: input.candidateId,
    display_name: name,
    providers: outcome.previous.providers,
  };
}
