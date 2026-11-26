/**
 * 一次 Surplus 调用的路由参数：折扣底线、供应商白名单 / 排序、屏蔽、路由目标与价格带。
 *
 * - 畅聊候选首发：折扣底线 + 白名单钉住上架时的那一家（思考参数按供应商定，不能随便派），路由目标沿用统一的可靠优先；
 * - 畅聊专用兜底（free_zone_config.fallback）：不设折扣底线（原价也兜底），优先的供应商只排序不限定，
 *   默认按速度排（latency）并放宽价格带。
 * 所有 Surplus 请求永远屏蔽 SURPLUS_ALWAYS_BLOCKED_PROVIDERS（在 upstream.forwardToUpstream 统一合并）。
 */
import type { FreeZoneFallback, SurplusRouteObjective } from '@miniapp/shared';

export interface SurplusRoute {
  /** 白名单（body provider） */
  providers?: string[];
  /** 只排序、不改可选范围（body provider_order） */
  providerOrder?: string[];
  /** 额外屏蔽（body providers_blocked），与统一屏蔽取并集 */
  blocked?: string[];
  /** X-Min-Discount；不设 = 不限折扣 */
  minDiscountPct?: number;
  /** 不设 = 统一的可靠优先（upstream 默认头） */
  objective?: SurplusRouteObjective;
  tolerancePct?: number;
}

export function surplusRouteBody(route: SurplusRoute | undefined): Record<string, unknown> {
  if (!route) return {};
  return {
    ...(route.providers?.length ? { provider: route.providers } : {}),
    ...(route.providerOrder?.length ? { provider_order: route.providerOrder } : {}),
    ...(route.blocked?.length ? { providers_blocked: route.blocked } : {}),
  };
}

export function surplusRouteHeaders(route: SurplusRoute | undefined): Record<string, string> {
  if (!route) return {};
  return {
    ...(route.minDiscountPct !== undefined
      ? { 'X-Min-Discount': String(route.minDiscountPct) }
      : {}),
    ...(route.objective ? { 'X-SI-Route-Objective': route.objective } : {}),
    ...(route.tolerancePct !== undefined
      ? { 'X-SI-Route-Tolerance-Pct': String(route.tolerancePct) }
      : {}),
  };
}

/** 畅聊专用兜底的路由：没有折扣底线 */
export function freeZoneFallbackRoute(
  fallback: FreeZoneFallback,
  blockedProviders: readonly string[]
): SurplusRoute {
  return {
    ...(fallback.preferred_provider ? { providerOrder: [fallback.preferred_provider] } : {}),
    ...(blockedProviders.length ? { blocked: [...blockedProviders] } : {}),
    objective: fallback.route_objective,
    tolerancePct: fallback.price_tolerance_pct,
  };
}

/** 思考参数按哪家供应商的规矩发：白名单钉住的那家，否则优先的那家 */
export function surplusRouteProvider(route: SurplusRoute | undefined): string | undefined {
  return route?.providers?.[0] ?? route?.providerOrder?.[0];
}
