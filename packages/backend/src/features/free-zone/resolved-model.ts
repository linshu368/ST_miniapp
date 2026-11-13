/**
 * 把一个可用的畅聊免费模型拼成生成链路要的 ResolvedModel。
 *
 * 主调用走 Surplus（带折扣底线 + 供应商白名单），兜底沿用付费目录配置的兜底模型（1017）；
 * 首字参数用畅聊自己的「等多久启动兜底」和「总上限」，只对免费模型生效。
 */
import {
  DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  resolveFallbackProviders,
} from '@miniapp/shared';
import type { fetchModelCatalogSnapshot, LlmPricingConfig } from '../../platform/model-tiers.js';
import type { ResolvedModel } from '../generation/types.js';
import type { FreeZoneSnapshot } from './snapshot.js';
import type { ListedFreeModel } from './zone-view.js';

export function buildFreeZoneResolvedModel(input: {
  listed: ListedFreeModel;
  zone: FreeZoneSnapshot;
  catalogSnapshot: Awaited<ReturnType<typeof fetchModelCatalogSnapshot>>;
  pricing: LlmPricingConfig;
  entitlement: ResolvedModel['entitlement'];
}): ResolvedModel {
  const { candidate, providers } = input.listed;
  const { catalog, version } = input.catalogSnapshot;
  const originalCredits = Math.max(
    0,
    Math.round(input.pricing.fixedDeduction[candidate.benchmark_tier])
  );
  return {
    modelId: candidate.id,
    provider: 'surplus',
    providerModelId: candidate.surplus_model,
    openRouterModelId: candidate.surplus_model,
    tier: null,
    isFree: false,
    entitlement: input.entitlement,
    billingContext: {
      modelId: candidate.id,
      modelDisplayName: candidate.display_name,
      provider: 'surplus',
      providerModelId: candidate.surplus_model,
      openRouterModelId: candidate.surplus_model,
      modelTier: null,
      catalogVersion: version,
      isFree: false,
      freeZone: { candidateId: candidate.id, originalCredits },
    },
    firstTokenPolicy: {
      fallbackModelId: catalog.fallback_model_id ?? FIRST_TOKEN_FALLBACK_MODEL_ID,
      fallbackProviders: resolveFallbackProviders(catalog),
      timeoutMs: input.zone.config.first_token.primary_wait_ms,
      fallbackTimeoutMs: catalog.fallback_timeout_ms ?? DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
      deadlineMs: input.zone.config.first_token.deadline_ms,
      timeoutRateTarget:
        catalog.first_token_timeout_rate_target ?? DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
      catalogVersion: version,
    },
    freeZone: {
      candidateId: candidate.id,
      providers,
      minDiscountPct: input.zone.config.screening.min_discount_pct,
      parallelRequests: candidate.parallel_requests,
    },
  };
}
