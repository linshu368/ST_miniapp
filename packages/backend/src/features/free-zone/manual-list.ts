/**
 * 运营手动「立即上架」一个畅聊候选：不等连续达标、不等冷却。
 *
 * 供应商：运营指定就用指定的；没指定就按当前行情和已发布的初筛门槛选（和评估同一套规则，
 * 但不看排除期——运营明确要上，排除的那家也可以用）。没有达标的又没指定，就不上，告诉运营原因。
 * 上架前和评估一样真发一次派单探测：订单簿看着达标、按折扣底线却派不出单的供应商不上，
 * 否则用户每一轮都落到兜底（11-12 实测 DeepSeek 官方渠道就是这样）。
 * 上架后和普通在架模型一样，每 30 分钟评估一次，不达标照常换供应商或下架。
 */
import type { AdminFreeZoneListNowResponse, FreeZoneConfig } from '@miniapp/shared';
import { fetchFreeZoneConfig } from './config.js';
import { initialState, listManually } from './lifecycle.js';
import { createSurplusProbe, type ProbeFn } from './probe.js';
import { applyProbes } from './probe-screening.js';
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
  probe: ProbeFn;
  now: () => Date;
}

const defaultDeps: ListNowDeps = {
  loadConfig: fetchFreeZoneConfig,
  fetchMarket: fetchSurplusModelMarket,
  save: saveManualListing,
  probe: createSurplusProbe(),
  now: () => new Date(),
};

/** 运营指定的供应商也要派得出单；探测关着就不探。 */
async function checkRequestedProvider(
  config: FreeZoneConfig,
  surplusModel: string,
  provider: string,
  deps: ListNowDeps
): Promise<void> {
  if (!config.screening.probe_enabled) return;
  const result = await deps.probe({
    model: surplusModel,
    provider,
    minDiscountPct: config.screening.min_discount_pct,
  });
  if (result.outcome === 'unroutable') {
    throw new FreeZoneListNowError(
      409,
      `${provider} 按 ${config.screening.min_discount_pct}% 折扣底线派不出单（${result.detail ?? ''}）`
    );
  }
  if (result.outcome === 'error') {
    throw new FreeZoneListNowError(
      502,
      `派单探测没有结果（${result.detail ?? '网络问题'}），稍后再试`
    );
  }
}

async function providerFromScreening(
  config: FreeZoneConfig,
  candidateId: string,
  surplusModel: string,
  deps: ListNowDeps
): Promise<string> {
  let market: SurplusModelMarket;
  try {
    market = await deps.fetchMarket(surplusModel);
  } catch {
    throw new FreeZoneListNowError(502, 'Surplus 行情暂时拿不到，可以指定供应商后再上架');
  }
  const screened = screenModel(market, config.screening);
  // 和评估同一套探测：按 pickProvider 的顺序探，派不出去就换下一家，最多 3 家
  const probed = await applyProbes({
    model: surplusModel,
    screening: screened,
    state: initialState(candidateId),
    now: deps.now(),
    rules: config.screening,
    probe: deps.probe,
  });
  if (probed.hold) {
    throw new FreeZoneListNowError(
      502,
      `派单探测没有结果（${probed.chosen?.detail ?? '网络问题'}），稍后再试`
    );
  }
  const screening = probed.screening ?? screened;
  const provider = screening.pass
    ? probed.chosen?.outcome === 'ok'
      ? probed.chosen.provider
      : pickProvider(screening.qualified, { ratio: config.screening.price_band_ratio })
    : null;
  if (!provider) {
    const reasons = screening.reasons.slice(-3).join('；') || '没有达标的供应商';
    throw new FreeZoneListNowError(409, `没有能用的供应商（${reasons}）`);
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
  if (input.provider) {
    await checkRequestedProvider(config, candidate.surplus_model, input.provider, deps);
  }
  const provider =
    input.provider ??
    (await providerFromScreening(config, candidate.id, candidate.surplus_model, deps));
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
