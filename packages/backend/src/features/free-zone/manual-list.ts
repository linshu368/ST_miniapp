/**
 * 运营手动「上架」一个畅聊候选。固定一家供应商，之后不自动变：思考参数要按供应商决定
 * （mistral 收到 reasoning 会 400，Gemini 不带 reasoning 首字要 6～30 秒），不能放开让 Surplus 随便派。
 *
 * 供应商：运营指定就用指定的（屏蔽渠道除外）；没指定就按当前报价，选达到折扣底线、可用的
 * trusted 供应商里折扣最高的一家。没有达标的就不上，告诉运营最好的是多少。
 */
import {
  freeZoneDiscountFloor,
  type AdminFreeZoneListNowResponse,
  type FreeZoneConfig,
} from '@miniapp/shared';
import { fetchFreeZoneConfig } from './config.js';
import { initialState, listManually } from './lifecycle.js';
import { saveManualListing, type ManualListingOutcome } from './repository.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';
import {
  fetchSurplusMarketBook,
  type MarketBook,
  type MarketDirectPrice,
} from './surplus-market.js';

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
  fetchBook: (model: string) => Promise<MarketBook>;
  save: typeof saveManualListing;
  now: () => Date;
}

const defaultDeps: ListNowDeps = {
  loadConfig: fetchFreeZoneConfig,
  fetchBook: fetchSurplusMarketBook,
  save: saveManualListing,
  now: () => new Date(),
};

function isBlocked(blocked: readonly string[], provider: string): boolean {
  return blocked.some((item) => item.toLowerCase() === provider.toLowerCase());
}

/** 可用的 trusted 供应商各自最高的折扣，按折扣从高到低；屏蔽渠道不算 */
export function rankProviders(
  book: MarketBook,
  blocked: readonly string[]
): Array<{ provider: string; discountPct: number }> {
  const best = new Map<string, number>();
  for (const offer of book.offers) {
    if (!offer.trusted || !offer.available || !offer.healthy || offer.discountPct === null)
      continue;
    if (isBlocked(blocked, offer.provider)) continue;
    best.set(
      offer.provider,
      Math.max(best.get(offer.provider) ?? Number.NEGATIVE_INFINITY, offer.discountPct)
    );
  }
  return [...best]
    .map(([provider, discountPct]) => ({ provider, discountPct }))
    .sort((a, b) => b.discountPct - a.discountPct || a.provider.localeCompare(b.provider));
}

async function providerFromMarket(
  surplusModel: string,
  floor: number,
  blocked: readonly string[],
  deps: ListNowDeps
): Promise<{ provider: string; directPrice: MarketDirectPrice | null }> {
  let book: MarketBook;
  try {
    book = await deps.fetchBook(surplusModel);
  } catch {
    throw new FreeZoneListNowError(502, 'Surplus 行情暂时拿不到，可以指定供应商后再上架');
  }
  const top = rankProviders(book, blocked)[0];
  if (!top) throw new FreeZoneListNowError(409, '现在没有可用的 trusted 供应商');
  if (top.discountPct < floor) {
    throw new FreeZoneListNowError(
      409,
      `没有供应商达到 ${floor}% 折扣底线（最好的是 ${top.provider} ${top.discountPct}%）`
    );
  }
  return { provider: top.provider, directPrice: book.directPrice };
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
  const blocked = config.screening.blocked_providers;
  if (input.provider && isBlocked(blocked, input.provider)) {
    throw new FreeZoneListNowError(409, `${input.provider} 在屏蔽渠道里，先移除再上架`);
  }
  const picked = input.provider
    ? { provider: input.provider, directPrice: null }
    : await providerFromMarket(
        candidate.surplus_model,
        freeZoneDiscountFloor(config.screening, candidate),
        blocked,
        deps
      );
  const outcome: ManualListingOutcome = await deps.save({
    candidateId: candidate.id,
    surplusModel: candidate.surplus_model,
    directPrice: picked.directPrice,
    build: (current) =>
      listManually({
        state: current ?? initialState(candidate.id),
        provider: picked.provider,
        now: deps.now(),
      }),
  });
  if (outcome.kind === 'already_listed') {
    throw new FreeZoneListNowError(
      409,
      `${candidate.display_name} 已经在架（供应商 ${outcome.providers.join('、')}），要换供应商先下架`
    );
  }
  invalidateFreeZoneSnapshot();
  return {
    candidate_id: candidate.id,
    display_name: candidate.display_name,
    provider: picked.provider,
    provider_source: input.provider ? 'requested' : 'market',
  };
}
