/**
 * 官方数据初筛与供应商选择（纯函数）。上架前的准入、在架时每 30 分钟的复核都用这一套。
 *
 * 只看 trusted 的报价（用户定的硬条件，不做成开关）。门槛为 null 表示不检查；
 * 门槛设了但数据未知（平台给 null、样本不足没出单元格），按不达标处理——
 * 宁可少上一个模型，也不把没把握的渠道给用户用。
 */
import type { FreeZoneScreening } from '@miniapp/shared';
import type { MarketBook, ProviderPerformance, SurplusModelMarket } from './surplus-market.js';

export interface ProviderScreening {
  provider: string;
  qualifiedOffers: number;
  /** 达标报价里最便宜的价格；Surplus 在白名单内按便宜优先派单，所以这就是预期价 */
  price: number | null;
  performance: ProviderPerformance | null;
  failures: string[];
}

export interface QualifiedProvider {
  provider: string;
  price: number | null;
  ttftP50Ms: number | null;
  qualifiedOffers: number;
}

export interface ScreeningResult {
  /** 模型层达标且至少有一家供应商达标 */
  pass: boolean;
  /** 所有达标的供应商（未排序；挑哪家由 pickProvider 决定） */
  qualified: QualifiedProvider[];
  /** 不达标原因（模型层 + 供应商层汇总），用于事件记录和看板 */
  reasons: string[];
  realized7dDiscountPct: number | null;
  detail: ProviderScreening[];
}

function atLeast(value: number | null, min: number | null, label: string): string | null {
  if (min === null) return null;
  if (value === null) return `${label}未知`;
  return value >= min ? null : `${label} ${round(value)} < ${min}`;
}

function atMost(value: number | null, max: number | null, label: string): string | null {
  if (max === null) return null;
  if (value === null) return `${label}未知`;
  return value <= max ? null : `${label} ${round(value)} > ${max}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function qualifiedOffers(
  book: MarketBook,
  minDiscountPct: number
): Map<string, { count: number; price: number | null }> {
  const byProvider = new Map<string, { count: number; price: number | null }>();
  for (const offer of book.offers) {
    if (!offer.trusted) continue;
    const entry = byProvider.get(offer.provider) ?? { count: 0, price: null };
    byProvider.set(offer.provider, entry);
    const qualified =
      offer.available &&
      offer.healthy &&
      offer.discountPct !== null &&
      offer.discountPct >= minDiscountPct;
    if (!qualified) continue;
    entry.count += 1;
    if (offer.pricePer1m !== null && (entry.price === null || offer.pricePer1m < entry.price)) {
      entry.price = offer.pricePer1m;
    }
  }
  return byProvider;
}

function screenProvider(
  provider: string,
  offers: { count: number; price: number | null },
  perf: ProviderPerformance | null,
  rules: FreeZoneScreening
): ProviderScreening {
  const failures = [
    rules.min_qualified_offers === null || offers.count >= rules.min_qualified_offers
      ? null
      : `达标报价 ${offers.count} < ${rules.min_qualified_offers}`,
    atLeast(perf?.requests ?? null, rules.min_samples, '样本量'),
    atLeast(perf?.uptimePct ?? null, rules.min_uptime_pct, '成功率'),
    atMost(perf?.ttftP50Ms ?? null, rules.max_ttft_p50_ms, '首字p50'),
    atMost(perf?.ttftP90Ms ?? null, rules.max_ttft_p90_ms, '首字p90'),
    atLeast(perf?.tpsP50 ?? null, rules.min_tps, '出字速度'),
  ].filter((item): item is string => item !== null);
  return {
    provider,
    qualifiedOffers: offers.count,
    price: offers.price,
    performance: perf,
    failures,
  };
}

export function screenModel(market: SurplusModelMarket, rules: FreeZoneScreening): ScreeningResult {
  const offers = qualifiedOffers(market.book, rules.min_discount_pct);
  const perfByProvider = new Map(market.performance.map((row) => [row.provider, row]));
  const detail = [...offers.entries()].map(([provider, entry]) =>
    screenProvider(provider, entry, perfByProvider.get(provider) ?? null, rules)
  );
  const qualified = detail
    .filter((row) => row.failures.length === 0)
    .map((row) => ({
      provider: row.provider,
      price: row.price,
      ttftP50Ms: row.performance?.ttftP50Ms ?? null,
      qualifiedOffers: row.qualifiedOffers,
    }));

  const modelFailure = atLeast(
    market.book.realized7dDiscountPct,
    rules.min_realized_discount_pct,
    '7天成交折扣'
  );
  const reasons: string[] = [];
  if (modelFailure) reasons.push(modelFailure);
  if (detail.length === 0) reasons.push('没有 trusted 供应商');
  else if (qualified.length === 0) {
    for (const row of detail) reasons.push(`${row.provider}: ${row.failures.join('，')}`);
  }

  return {
    pass: modelFailure === null && qualified.length > 0,
    qualified,
    reasons,
    realized7dDiscountPct: market.book.realized7dDiscountPct,
    detail,
  };
}

const UNKNOWN = Number.POSITIVE_INFINITY;

/**
 * 从达标供应商里挑一家（用户定的规则）：
 * - 已经在用的那家只要还达标、没被排除，就一直用——换来换去缓存会一直不命中；
 * - 否则先按价格分档：和最便宜的一家差不到 ratio 倍的算同一档，在这一档里挑首字 p50 最低的；
 *   更贵的档只有便宜档没人时才会轮到（价格未知的排在所有有价的后面）。
 * 换供应商（初选、复核不达标、业务越线）都走这一个函数。
 */
export function pickProvider(
  qualified: QualifiedProvider[],
  options: { current?: string | null; excluded?: ReadonlySet<string>; ratio: number }
): string | null {
  const pool = qualified.filter((item) => !options.excluded?.has(item.provider));
  if (options.current && pool.some((item) => item.provider === options.current)) {
    return options.current;
  }
  if (pool.length === 0) return null;
  const priced = pool.filter((item) => item.price !== null);
  const cheapest =
    priced.length > 0 ? Math.min(...priced.map((item) => item.price ?? UNKNOWN)) : null;
  const band =
    cheapest === null
      ? pool
      : priced.filter(
          (item) => item.price === cheapest || (item.price ?? UNKNOWN) < cheapest * options.ratio
        );
  const best = [...band].sort(
    (a, b) =>
      (a.ttftP50Ms ?? UNKNOWN) - (b.ttftP50Ms ?? UNKNOWN) ||
      (a.price ?? UNKNOWN) - (b.price ?? UNKNOWN) ||
      b.qualifiedOffers - a.qualifiedOffers
  )[0];
  return best?.provider ?? null;
}
