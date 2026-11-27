/**
 * 运营平台「模型供应商路由」查 Surplus 某模型各供应商的报价与 24h 表现，给填规则时参考。
 * 报价簿读不到就整体失败（没有供应商列表）；表现读不到只缺首字 / 可用率，照常返回报价。
 */
import {
  SURPLUS_ALWAYS_BLOCKED_PROVIDERS,
  type SurplusProviderMarket,
  type SurplusProviderMarketRow,
} from '@miniapp/shared';
import {
  fetchSurplusMarketBook,
  fetchSurplusProviderPerformance,
  type MarketOffer,
  type ProviderPerformance,
} from '../free-zone/surplus-market.js';

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 100) / 100;
}

export function summarizeSurplusProviders(
  offers: MarketOffer[],
  performance: ProviderPerformance[]
): SurplusProviderMarketRow[] {
  const blocked = new Set(SURPLUS_ALWAYS_BLOCKED_PROVIDERS.map((slug) => slug.toLowerCase()));
  const perf = new Map(performance.map((row) => [row.provider.toLowerCase(), row]));
  const groups = new Map<string, MarketOffer[]>();
  for (const offer of offers)
    groups.set(offer.provider, [...(groups.get(offer.provider) ?? []), offer]);
  const rows = [...groups].map(([provider, group]): SurplusProviderMarketRow => {
    const live = group.filter((offer) => offer.available && offer.healthy);
    const discounts = live
      .flatMap((offer) => (offer.discountPct === null ? [] : [offer.discountPct]))
      .sort((a, b) => a - b);
    const stats = perf.get(provider.toLowerCase());
    return {
      provider,
      trusted: group.some((offer) => offer.trusted),
      always_blocked: blocked.has(provider.toLowerCase()),
      offers: group.length,
      available_offers: live.length,
      best_discount_pct: discounts.at(-1) ?? null,
      median_discount_pct: median(discounts),
      ttft_p50_ms: stats?.ttftP50Ms ?? null,
      uptime_pct: stats?.uptimePct ?? null,
    };
  });
  // 有在线卖家的排前面，再按最高折扣从高到低
  return rows.sort(
    (a, b) =>
      Number(b.available_offers > 0) - Number(a.available_offers > 0) ||
      (b.best_discount_pct ?? -1) - (a.best_discount_pct ?? -1)
  );
}

export async function loadSurplusProviderMarket(model: string): Promise<SurplusProviderMarket> {
  const [book, performance] = await Promise.allSettled([
    fetchSurplusMarketBook(model),
    fetchSurplusProviderPerformance(model),
  ]);
  if (book.status === 'rejected') throw book.reason;
  return {
    model,
    fetched_at: new Date().toISOString(),
    performance_status: performance.status === 'fulfilled' ? 'ok' : 'failed',
    providers: summarizeSurplusProviders(
      book.value.offers,
      performance.status === 'fulfilled' ? performance.value : []
    ),
  };
}
