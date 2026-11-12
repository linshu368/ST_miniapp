/**
 * 运营手动「立即上架」一个畅聊候选：不等连续达标、不等冷却。
 *
 * 供应商：运营指定就用指定的；没指定就按当前行情和已发布的初筛门槛选（和评估同一套规则，
 * 但不看排除期——运营明确要上，排除的那家也可以用）。没有达标的又没指定，就不上，告诉运营原因。
 * 上架后和普通在架模型一样，每 30 分钟评估一次，不达标照常换供应商或下架。
 */
import type { AdminFreeZoneListNowResponse, FreeZoneConfig } from '@miniapp/shared';
import { fetchFreeZoneConfig } from './config.js';
import { initialState, listManually } from './lifecycle.js';
import { saveManualListing, type ManualListingOutcome } from './repository.js';
import { pickProvider, screenModel } from './screening.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';
import { fetchSurplusModelMarket, type SurplusModelMarket } from './surplus-market.js';

export class FreeZoneListNowError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 502,
    message: string
  ) {
    super(message);
  }
}

export interface ListNowDeps {
  loadConfig: () => Promise<FreeZoneConfig>;
  fetchMarket: (model: string) => Promise<SurplusModelMarket>;
  save: typeof saveManualListing;
  now: () => Date;
}

const defaultDeps: ListNowDeps = {
  loadConfig: fetchFreeZoneConfig,
  fetchMarket: fetchSurplusModelMarket,
  save: saveManualListing,
  now: () => new Date(),
};

async function providerFromScreening(
  config: FreeZoneConfig,
  surplusModel: string,
  deps: ListNowDeps
): Promise<string> {
  let market: SurplusModelMarket;
  try {
    market = await deps.fetchMarket(surplusModel);
  } catch {
    throw new FreeZoneListNowError(502, 'Surplus 行情暂时拿不到，可以指定供应商后再上架');
  }
  const screening = screenModel(market, config.screening);
  const provider = screening.pass
    ? pickProvider(screening.qualified, { ratio: config.screening.price_band_ratio })
    : null;
  if (!provider) {
    const reasons = screening.reasons.slice(0, 3).join('；') || '没有达标的供应商';
    throw new FreeZoneListNowError(409, `按当前门槛没有能用的供应商（${reasons}），可以指定一家`);
  }
  return provider;
}

export async function listFreeZoneModelNow(
  input: { candidateId: string; provider?: string },
  deps: ListNowDeps = defaultDeps
): Promise<AdminFreeZoneListNowResponse> {
  const config = await deps.loadConfig();
  const candidate = config.candidates.find((item) => item.id === input.candidateId);
  if (!candidate) {
    throw new FreeZoneListNowError(404, `已发布的候选池里没有 ${input.candidateId}`);
  }
  const provider =
    input.provider ?? (await providerFromScreening(config, candidate.surplus_model, deps));
  const outcome: ManualListingOutcome = await deps.save({
    candidateId: candidate.id,
    surplusModel: candidate.surplus_model,
    build: (current) =>
      listManually({
        state: current ?? initialState(candidate.id),
        provider,
        now: deps.now(),
        requiredPasses: config.relist.required_passes,
      }),
  });
  if (outcome.kind === 'already_listed') {
    throw new FreeZoneListNowError(
      409,
      `${candidate.display_name} 已经在架（供应商 ${outcome.providers.join('、')}）`
    );
  }
  invalidateFreeZoneSnapshot();
  return {
    candidate_id: candidate.id,
    display_name: candidate.display_name,
    provider,
    provider_source: input.provider ? 'requested' : 'screening',
    previous_status: outcome.previous?.status ?? null,
  };
}
