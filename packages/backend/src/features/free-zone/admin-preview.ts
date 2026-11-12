/**
 * 运营平台「按当前门槛筛选」：拿 Surplus 实时行情，用运营页面上的初筛门槛把候选池过一遍。
 *
 * 只读：不写状态表、不影响评估任务。和评估任务用同一个 screenModel / pickProvider，
 * 所以这里说达标，评估任务看到的也是达标（行情在两次之间变了除外）。
 * 行情按模型缓存 1 分钟：运营改一个门槛再点一次，不用重新等 Surplus。
 */
import type {
  AdminFreeZoneModelResult,
  AdminFreeZoneScreeningResponse,
  FreeZoneScreening,
  FreeZoneScreeningCheckKey,
} from '@miniapp/shared';
import { pickProvider, screenModel } from './screening.js';
import { fetchSurplusModelMarket, type SurplusModelMarket } from './surplus-market.js';

const CACHE_TTL_MS = 60_000;
const CONCURRENCY = 4;

/** 可以单独「放开」看影响的门槛（必填的折扣底线、分档倍数不在内）。 */
const OPTIONAL_CHECKS: readonly Exclude<FreeZoneScreeningCheckKey, 'probe'>[] = [
  'min_qualified_offers',
  'min_samples',
  'min_uptime_pct',
  'max_ttft_p50_ms',
  'max_ttft_p90_ms',
  'min_tps',
  'min_cache_hit_rate_pct',
  'min_realized_discount_pct',
];

export interface PreviewCandidate {
  id: string;
  surplus_model: string;
  display_name: string;
}

type MarketFetcher = (model: string) => Promise<SurplusModelMarket>;

const cache = new Map<string, { at: number; market: SurplusModelMarket }>();

export function clearScreeningPreviewCache(): void {
  cache.clear();
}

function cachedFetcher(fetchMarket: MarketFetcher, now: () => number): MarketFetcher {
  return async (model) => {
    const key = model.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.market;
    const market = await fetchMarket(model);
    cache.set(key, { at: now(), market });
    return market;
  };
}

async function fetchAll(
  candidates: PreviewCandidate[],
  fetchMarket: MarketFetcher
): Promise<Array<SurplusModelMarket | Error>> {
  const results: Array<SurplusModelMarket | Error> = [];
  for (let start = 0; start < candidates.length; start += CONCURRENCY) {
    const batch = candidates.slice(start, start + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((candidate) =>
          fetchMarket(candidate.surplus_model).catch((err: unknown) =>
            err instanceof Error ? err : new Error(String(err))
          )
        )
      ))
    );
  }
  return results;
}

function candidateKey(candidate: PreviewCandidate): string {
  return candidate.id || candidate.surplus_model;
}

function modelResult(
  candidate: PreviewCandidate,
  market: SurplusModelMarket | Error,
  rules: FreeZoneScreening
): AdminFreeZoneModelResult {
  const base = {
    candidate_id: candidateKey(candidate),
    display_name: candidate.display_name || candidate.surplus_model,
    surplus_model: candidate.surplus_model,
  };
  if (market instanceof Error) {
    return {
      ...base,
      error: `Surplus 行情没拿到：${market.message}`,
      pass: false,
      picked_provider: null,
      model_checks: [],
      providers: [],
      reasons: [],
    };
  }
  const result = screenModel(market, rules);
  return {
    ...base,
    error: null,
    pass: result.pass,
    picked_provider: result.pass
      ? pickProvider(result.qualified, { ratio: rules.price_band_ratio })
      : null,
    model_checks: [result.modelCheck],
    providers: result.detail.map((row) => ({
      provider: row.provider,
      qualified: row.failures.length === 0,
      qualified_offers: row.qualifiedOffers,
      price_per_1m: row.price,
      checks: row.checks,
    })),
    reasons: result.reasons,
  };
}

/**
 * 每个可选门槛单独放开，看会多出哪些达标候选——帮运营判断哪一项卡得最多。
 * 放开 = 改成不检查；达标报价数例外，按「降到 1」算：一个达标报价都没有的供应商，
 * 带着折扣底线的请求根本派不出去，算它达标会误导。
 */
export function parameterImpact(
  entries: Array<{ id: string; market: SurplusModelMarket; pass: boolean }>,
  rules: FreeZoneScreening
): AdminFreeZoneScreeningResponse['impact'] {
  return OPTIONAL_CHECKS.filter((key) => rules[key] !== null).map((key) => {
    const relaxed = { ...rules, [key]: key === 'min_qualified_offers' ? 1 : null };
    return {
      key,
      unlocks: entries
        .filter((entry) => !entry.pass && screenModel(entry.market, relaxed).pass)
        .map((entry) => entry.id),
    };
  });
}

export async function previewFreeZoneScreening(
  input: { candidates: PreviewCandidate[]; screening: FreeZoneScreening },
  deps: { fetchMarket?: MarketFetcher; now?: () => number } = {}
): Promise<AdminFreeZoneScreeningResponse> {
  const now = deps.now ?? Date.now;
  const fetchMarket = cachedFetcher(deps.fetchMarket ?? fetchSurplusModelMarket, now);
  const markets = await fetchAll(input.candidates, fetchMarket);
  const models = input.candidates.map((candidate, index) =>
    modelResult(candidate, markets[index] ?? new Error('missing'), input.screening)
  );
  const entries = input.candidates.flatMap((candidate, index) => {
    const market = markets[index];
    return market && !(market instanceof Error)
      ? [{ id: candidateKey(candidate), market, pass: models[index]?.pass ?? false }]
      : [];
  });
  return {
    checked_at: new Date(now()).toISOString(),
    models,
    impact: parameterImpact(entries, input.screening),
  };
}
