/**
 * 把一个可用的畅聊免费模型拼成生成链路要的 ResolvedModel。
 *
 * 候选池（Surplus）模型：主调用带折扣底线 + 供应商白名单，可并发多路；首字参数用畅聊自己的
 * 「等多久启动兜底」和「总上限」。模型目录「免费畅聊」板块的模型：和轻量/标准/旗舰完全同一条
 * 通路（一次首发 + 兜底，首字参数取模型目录），只是本轮按畅聊计费（扣 0，记原价）。
 * 兜底：配了畅聊专用兜底（free_zone_config.fallback）就走它——Surplus、不设折扣底线、按速度排、
 * 屏蔽渠道照样生效；没配沿用付费目录配置的兜底模型（OpenRouter 1017）。两种来源都一样。
 */
import {
  DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  freeZoneDiscountFloor,
  resolveFallbackProviders,
} from '@miniapp/shared';
import type { fetchModelCatalogSnapshot, LlmPricingConfig } from '../../platform/model-tiers.js';
import type { ResolvedModel } from '../generation/types.js';
import { freeZoneFallbackRoute } from '../generation/surplus-route.js';
import type { FreeZoneSnapshot } from './snapshot.js';
import { freeModelUpstream, type ListedFreeModel } from './zone-view.js';

interface BuildInput {
  listed: ListedFreeModel;
  zone: FreeZoneSnapshot;
  catalogSnapshot: Awaited<ReturnType<typeof fetchModelCatalogSnapshot>>;
  pricing: LlmPricingConfig;
  entitlement: ResolvedModel['entitlement'];
}

/** 两种来源共用：上游、按畅聊计费（扣 0，原价按对标档位记进快照） */
function freeZoneBase(input: BuildInput) {
  const { candidate } = input.listed;
  const { provider, providerModelId } = freeModelUpstream(input.listed);
  const originalCredits = Math.max(
    0,
    Math.round(input.pricing.fixedDeduction[candidate.benchmark_tier])
  );
  return {
    modelId: candidate.id,
    provider,
    providerModelId,
    openRouterModelId: providerModelId,
    tier: null,
    entitlement: input.entitlement,
    billingContext: {
      modelId: candidate.id,
      modelDisplayName: candidate.display_name,
      provider,
      providerModelId,
      openRouterModelId: providerModelId,
      modelTier: null,
      catalogVersion: input.catalogSnapshot.version,
      freeZone: { candidateId: candidate.id, originalCredits },
    },
  } satisfies ResolvedModel;
}

export function buildFreeZoneResolvedModel(input: BuildInput): ResolvedModel {
  const base = freeZoneBase(input);
  const { catalog, version } = input.catalogSnapshot;
  const own = input.zone.config.fallback;
  const firstTokenCommon = {
    ...(own
      ? {
          fallback: {
            provider: 'surplus' as const,
            providerModelId: own.surplus_model,
            surplusRoute: freeZoneFallbackRoute(own, input.zone.config.screening.blocked_providers),
          },
          // 冻结进本轮请求记录：兜底 attempt 的模型名以它为准
          fallbackModelId: own.surplus_model,
        }
      : {
          fallbackModelId: catalog.fallback_model_id ?? FIRST_TOKEN_FALLBACK_MODEL_ID,
          fallbackProviders: resolveFallbackProviders(catalog),
        }),
    fallbackTimeoutMs: catalog.fallback_timeout_ms ?? DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
    timeoutRateTarget:
      catalog.first_token_timeout_rate_target ?? DEFAULT_FIRST_TOKEN_TIMEOUT_RATE_TARGET,
    catalogVersion: version,
  };
  if (input.listed.source === 'catalog') {
    return {
      ...base,
      firstTokenPolicy: {
        ...firstTokenCommon,
        timeoutMs: input.listed.candidate.first_token_timeout_ms ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
        deadlineMs: catalog.first_token_deadline_ms ?? DEFAULT_FIRST_TOKEN_DEADLINE_MS,
      },
    };
  }
  const { candidate, providers } = input.listed;
  return {
    ...base,
    firstTokenPolicy: {
      ...firstTokenCommon,
      timeoutMs: input.zone.config.first_token.primary_wait_ms,
      deadlineMs: input.zone.config.first_token.deadline_ms,
    },
    freeZone: {
      candidateId: candidate.id,
      providers,
      // 这个模型单独设了折扣底线就按它，否则用统一值
      minDiscountPct: freeZoneDiscountFloor(input.zone.config.screening, candidate),
      routeObjective: candidate.route_objective,
      parallelRequests: candidate.parallel_requests,
    },
  };
}
