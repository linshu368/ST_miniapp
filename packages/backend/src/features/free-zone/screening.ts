/**
 * 官方数据初筛与供应商选择（纯函数）。上架前的准入、在架时每 30 分钟的复核都用这一套。
 *
 * 只看 trusted 的报价（用户定的硬条件，不做成开关）。门槛为 null 表示不检查；
 * 门槛设了但数据未知（平台给 null、样本不足没出单元格），按不达标处理——
 * 宁可少上一个模型，也不把没把握的渠道给用户用。
 */
import type {
  FreeZoneCheckSummary,
  FreeZoneScreening,
  FreeZoneScreeningCheck,
  FreeZoneScreeningCheckKey,
  FreeZoneScreeningSummary,
} from '@miniapp/shared';
import type { MarketBook, ProviderPerformance, SurplusModelMarket } from './surplus-market.js';

export interface ProviderScreening {
  provider: string;
  qualifiedOffers: number;
  /** 达标报价里最便宜的价格；Surplus 在白名单内按便宜优先派单，所以这就是预期价 */
  price: number | null;
  performance: ProviderPerformance | null;
  /** 逐项检查结果（运营平台的筛选预览按这个画表） */
  checks: FreeZoneScreeningCheck[];
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
  /** 模型层检查：7 天成交折扣 */
  modelCheck: FreeZoneScreeningCheck;
  detail: ProviderScreening[];
}

interface Check extends FreeZoneScreeningCheck {
  failure: string | null;
}

/** 门槛留空 = 不检查；门槛设了但值未知 = 不达标（宁可少上，不上没把握的）。 */
function check(
  key: FreeZoneScreeningCheckKey,
  value: number | null,
  threshold: number | null,
  direction: 'min' | 'max',
  label: string
): Check {
  if (threshold === null) return { key, value, threshold, pass: null, failure: null };
  if (value === null) return { key, value, threshold, pass: false, failure: `${label}未知` };
  const pass = direction === 'min' ? value >= threshold : value <= threshold;
  const sign = direction === 'min' ? '<' : '>';
  return {
    key,
    value,
    threshold,
    pass,
    failure: pass ? null : `${label} ${round(value)} ${sign} ${threshold}`,
  };
}

function publicCheck({ key, value, threshold, pass }: Check): FreeZoneScreeningCheck {
  return { key, value, threshold, pass };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 运营屏蔽的渠道：报价一律不参与竞争（和非 trusted 一样跳过）。 */
export function isBlockedProvider(rules: FreeZoneScreening, provider: string): boolean {
  const target = provider.toLowerCase();
  return rules.blocked_providers.some((item) => item.toLowerCase() === target);
}

function qualifiedOffers(
  book: MarketBook,
  rules: FreeZoneScreening,
  blockedSeen: Set<string>
): Map<string, { count: number; price: number | null }> {
  const byProvider = new Map<string, { count: number; price: number | null }>();
  for (const offer of book.offers) {
    if (!offer.trusted) continue;
    if (isBlockedProvider(rules, offer.provider)) {
      blockedSeen.add(offer.provider);
      continue;
    }
    const entry = byProvider.get(offer.provider) ?? { count: 0, price: null };
    byProvider.set(offer.provider, entry);
    const qualified =
      offer.available &&
      offer.healthy &&
      offer.discountPct !== null &&
      offer.discountPct >= rules.min_discount_pct;
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
  const checks = [
    check('min_qualified_offers', offers.count, rules.min_qualified_offers, 'min', '达标报价'),
    check('min_samples', perf?.requests ?? null, rules.min_samples, 'min', '样本量'),
    check('min_uptime_pct', perf?.uptimePct ?? null, rules.min_uptime_pct, 'min', '成功率'),
    check('max_ttft_p50_ms', perf?.ttftP50Ms ?? null, rules.max_ttft_p50_ms, 'max', '首字p50'),
    check('max_ttft_p90_ms', perf?.ttftP90Ms ?? null, rules.max_ttft_p90_ms, 'max', '首字p90'),
    check('min_tps', perf?.tpsP50 ?? null, rules.min_tps, 'min', '出字速度'),
    check(
      'min_cache_hit_rate_pct',
      perf?.cacheHitRatePct ?? null,
      rules.min_cache_hit_rate_pct,
      'min',
      '缓存命中率'
    ),
  ];
  return {
    provider,
    qualifiedOffers: offers.count,
    price: offers.price,
    performance: perf,
    checks: checks.map(publicCheck),
    failures: checks.flatMap((item) => (item.failure ? [item.failure] : [])),
  };
}

export function screenModel(market: SurplusModelMarket, rules: FreeZoneScreening): ScreeningResult {
  const blockedSeen = new Set<string>();
  const offers = qualifiedOffers(market.book, rules, blockedSeen);
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

  const modelCheck = check(
    'min_realized_discount_pct',
    market.book.realized7dDiscountPct,
    rules.min_realized_discount_pct,
    'min',
    '7天成交折扣'
  );
  const modelFailure = modelCheck.failure;
  const reasons: string[] = [];
  if (modelFailure) reasons.push(modelFailure);
  if (detail.length === 0) {
    reasons.push(
      blockedSeen.size > 0 ? `只有屏蔽渠道：${[...blockedSeen].join('、')}` : '没有 trusted 供应商'
    );
  } else if (qualified.length === 0) {
    for (const row of detail) reasons.push(`${row.provider}: ${row.failures.join('，')}`);
  }

  return {
    pass: modelFailure === null && qualified.length > 0,
    qualified,
    reasons,
    realized7dDiscountPct: market.book.realized7dDiscountPct,
    modelCheck: publicCheck(modelCheck),
    detail,
  };
}

/**
 * 把一轮初筛压成运营一眼能看的汇总：每一项有几家供应商过了（0 家 = 这一项把模型卡死），
 * 外加「离达标最近」的那家没过哪几项——每项都有人过、却没有一家全过时，靠它看差在哪。
 */
export function summarizeScreening(
  result: ScreeningResult,
  probe: { threshold: number; passed: number; total: number } | null = null
): FreeZoneScreeningSummary {
  const keys = result.detail[0]?.checks.map((item) => item.key) ?? [];
  const checks: FreeZoneCheckSummary[] = keys.map((key) => {
    const rows = result.detail.map((row) => row.checks.find((item) => item.key === key));
    return {
      key,
      threshold: rows[0]?.threshold ?? null,
      passed: rows.filter((item) => item?.pass === true).length,
      total: rows.length,
    };
  });
  checks.push({
    key: result.modelCheck.key,
    threshold: result.modelCheck.threshold,
    passed: result.modelCheck.pass === false ? 0 : 1,
    total: 1,
  });
  if (probe) checks.push({ key: 'probe', ...probe });
  const ranked = result.detail
    .map((row) => ({
      provider: row.provider,
      failed: row.checks.filter((item) => item.pass === false).map((item) => item.key),
    }))
    .sort((a, b) => a.failed.length - b.failed.length);
  return { pass: result.pass, checks, closest: ranked[0] ?? null };
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
