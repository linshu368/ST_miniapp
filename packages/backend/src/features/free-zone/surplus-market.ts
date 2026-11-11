/**
 * Surplus 公开行情接口（无需鉴权）：报价簿与分供应商性能。
 *
 * 只取初筛要用的字段，其余忽略；字段缺失或类型不对一律当「未知」(null)，
 * 由评估规则决定未知算不算过，而不是在这里猜默认值。
 * 单次请求 8 秒上限、不重试：评估任务每 30 分钟一轮，这一轮拿不到就等下一轮。
 */
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';

const REQUEST_TIMEOUT_MS = 8_000;

export interface MarketOffer {
  provider: string;
  discountPct: number | null;
  /** 输入+输出每百万 token 的实际售价（微美元），比较供应商贵贱用 */
  pricePer1m: number | null;
  available: boolean;
  healthy: boolean;
  trusted: boolean;
}

export interface MarketBook {
  offers: MarketOffer[];
  realized7dDiscountPct: number | null;
}

export interface ProviderPerformance {
  provider: string;
  requests: number | null;
  uptimePct: number | null;
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  tpsP50: number | null;
  cacheHitRatePct: number | null;
}

export interface SurplusModelMarket {
  book: MarketBook;
  /** 404 no_performance_data 时为空数组：平台没有足够样本，不是接口故障 */
  performance: ProviderPerformance[];
}

export class SurplusMarketError extends Error {
  constructor(
    readonly model: string,
    readonly stage: 'book' | 'performance',
    readonly status: number | null,
    cause?: unknown
  ) {
    super(`surplus market ${stage} for ${model} failed${status ? ` (${status})` : ''}`, { cause });
    this.name = 'SurplusMarketError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function surplusPublicOrigin(): string {
  return new URL(getLlmProviderRuntimeConfig('surplus').baseUrl).origin;
}

export function parseMarketBook(value: unknown): MarketBook {
  const root = isRecord(value) ? value : {};
  const offers = Array.isArray(root.offers) ? root.offers : [];
  const realized = isRecord(root.realized_7d) ? root.realized_7d : {};
  return {
    offers: offers.flatMap<MarketOffer>((item) => {
      if (!isRecord(item)) return [];
      const provider = text(item.provider_id);
      if (!provider) return [];
      return [
        {
          provider,
          discountPct: num(item.discount_pct),
          pricePer1m: num(item.price_per_1m),
          available: item.available === true,
          healthy: item.healthy === true,
          trusted: item.trusted === true,
        },
      ];
    }),
    realized7dDiscountPct: num(realized.discount_pct),
  };
}

export function parsePerformance(value: unknown): ProviderPerformance[] {
  const root = isRecord(value) ? value : {};
  const rows = Array.isArray(root.providers) ? root.providers : [];
  return rows.flatMap<ProviderPerformance>((item) => {
    if (!isRecord(item)) return [];
    const provider = text(item.provider);
    if (!provider) return [];
    return [
      {
        provider,
        requests: num(item.requests),
        uptimePct: num(item.uptime_pct),
        ttftP50Ms: num(item.ttft_p50_ms),
        ttftP90Ms: num(item.ttft_p90_ms),
        tpsP50: num(item.tps_p50),
        cacheHitRatePct: num(item.cache_hit_rate_pct),
      },
    ];
  });
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

export async function fetchSurplusModelMarket(
  model: string,
  options: { origin?: string; fetchImpl?: typeof fetch } = {}
): Promise<SurplusModelMarket> {
  const origin = options.origin ?? surplusPublicOrigin();
  const fetchImpl = options.fetchImpl ?? fetch;
  const encoded = encodeURIComponent(model);

  const [book, performance] = await Promise.all([
    getJson(`${origin}/api/markets/${encoded}`, fetchImpl).catch((err: unknown) => {
      throw new SurplusMarketError(model, 'book', null, err);
    }),
    getJson(`${origin}/api/analytics/performance/${encoded}`, fetchImpl).catch((err: unknown) => {
      throw new SurplusMarketError(model, 'performance', null, err);
    }),
  ]);
  if (book.status !== 200) throw new SurplusMarketError(model, 'book', book.status);
  if (performance.status !== 200 && performance.status !== 404) {
    throw new SurplusMarketError(model, 'performance', performance.status);
  }
  return {
    book: parseMarketBook(book.body),
    performance: performance.status === 404 ? [] : parsePerformance(performance.body),
  };
}
