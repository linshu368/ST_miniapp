/**
 * Surplus 公开报价簿（无需鉴权）：只在运营手动上架、没指定供应商时读一次，用来选供应商。
 * 字段缺失或类型不对一律当「未知」(null)。单次请求 8 秒上限、不重试。
 */
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';
import { clientFetch } from '../../platform/observability/fetch.js';

const fetch = clientFetch('free_zone.market', 'surplus');

const REQUEST_TIMEOUT_MS = 8_000;

export interface MarketOffer {
  provider: string;
  discountPct: number | null;
  available: boolean;
  healthy: boolean;
  trusted: boolean;
}

export interface MarketDirectPrice {
  inputPer1m: number | null;
  outputPer1m: number | null;
  source: string | null;
}

export interface MarketBook {
  offers: MarketOffer[];
  /** 直购参考价（折扣的基准，多为 OpenRouter 价），微美元/百万 token */
  directPrice: MarketDirectPrice | null;
}

export class SurplusMarketError extends Error {
  constructor(
    readonly model: string,
    readonly status: number | null,
    cause?: unknown
  ) {
    super(`surplus market book for ${model} failed${status ? ` (${status})` : ''}`, { cause });
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

function surplusPublicOrigin(): string {
  return new URL(getLlmProviderRuntimeConfig('surplus').baseUrl).origin;
}

export function parseMarketBook(value: unknown): MarketBook {
  const root = isRecord(value) ? value : {};
  const offers = Array.isArray(root.offers) ? root.offers : [];
  const direct = isRecord(root.direct_price) ? root.direct_price : null;
  return {
    offers: offers.flatMap<MarketOffer>((item) => {
      if (!isRecord(item)) return [];
      const provider = text(item.provider_id);
      if (!provider) return [];
      return [
        {
          provider,
          discountPct: num(item.discount_pct),
          available: item.available === true,
          healthy: item.healthy === true,
          trusted: item.trusted === true,
        },
      ];
    }),
    directPrice: direct
      ? {
          inputPer1m: num(direct.input_per_1m),
          outputPer1m: num(direct.output_per_1m),
          source: text(direct.reference_provider) ?? text(direct.reference_source),
        }
      : null,
  };
}

export async function fetchSurplusMarketBook(
  model: string,
  options: { origin?: string; fetchImpl?: typeof fetch } = {}
): Promise<MarketBook> {
  const origin = options.origin ?? surplusPublicOrigin();
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/markets/${encodeURIComponent(model)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SurplusMarketError(model, null, err);
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status !== 200) throw new SurplusMarketError(model, response.status);
  return parseMarketBook(body);
}
