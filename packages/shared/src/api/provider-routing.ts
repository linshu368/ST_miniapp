import { z } from 'zod';
import { SurplusRouteObjectiveSchema } from './free-zone.js';

/**
 * 「模型 × 供应商」路由配置（runtime_config key）。
 *
 * 背景：同一个 OpenRouter 模型背后有多个底层供应商，质量参差不齐（截断、内容过滤等）。
 * 运营按模型维度维护两类策略，请求时翻译成 OpenRouter 的 provider routing 参数：
 *   blocked_providers   -> provider.ignore（黑名单，直接屏蔽）
 *   preferred_providers -> provider.order + allow_fallbacks: true（优先尝试，其余兜底）
 *
 * 规则以 openrouter_model_id 为键：供应商策略只能绑定具体模型，数据结构上不存在
 * 「全局屏蔽某供应商」的写法（运营原则：同一供应商在不同模型上表现差异极大）。
 */
export const LLM_PROVIDER_ROUTING_CONFIG_KEY = 'llm_provider_routing_config';

/** OpenRouter 供应商 slug，如 alibaba / deepinfra / google-vertex / google-ai-studio。 */
export const ProviderSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/i,
    'provider slug must use letters, numbers, dots, slashes, underscores or hyphens'
  );

const OpenRouterModelIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[^\s/]+\/[^\s/]+$/);

function findDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) return value;
    seen.add(normalized);
  }
  return null;
}

export const ProviderRoutingRuleSchema = z
  .object({
    /** 上游模型 slug（与 llm_model_catalog 的 openrouter_model_id 同口径）。 */
    openrouter_model_id: OpenRouterModelIdSchema,
    /** 写入 provider.ignore 的供应商黑名单。 */
    blocked_providers: z.array(ProviderSlugSchema).max(20).default([]),
    /** 写入 provider.order 的优先供应商，未列出的供应商作为兜底。 */
    preferred_providers: z.array(ProviderSlugSchema).max(20).default([]),
    /** 运营备注：屏蔽原因、数据依据、日期，供周期复盘用。 */
    note: z.string().trim().max(200).default(''),
  })
  .superRefine((rule, ctx) => {
    if (rule.blocked_providers.length === 0 && rule.preferred_providers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rule must list at least one blocked or preferred provider',
      });
    }

    const duplicateBlocked = findDuplicate(rule.blocked_providers);
    if (duplicateBlocked) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blocked_providers'],
        message: `duplicate provider: ${duplicateBlocked}`,
      });
    }

    const duplicatePreferred = findDuplicate(rule.preferred_providers);
    if (duplicatePreferred) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preferred_providers'],
        message: `duplicate provider: ${duplicatePreferred}`,
      });
    }

    const blocked = new Set(rule.blocked_providers.map((slug) => slug.toLowerCase()));
    const conflicting = rule.preferred_providers.find((slug) => blocked.has(slug.toLowerCase()));
    if (conflicting) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preferred_providers'],
        message: `provider cannot be both blocked and preferred: ${conflicting}`,
      });
    }
  });

/**
 * Surplus 模型 × 供应商路由（surplus_rules）。和 OpenRouter 不同：Surplus 只能指定到供应商这一层
 * （mistral / deepseek / google…），同一供应商下面的匿名卖家选不了；另有折扣底线和派单方式。
 *   allowed_providers   -> body provider（白名单，硬限制；都没卖家时 Surplus 404/503，交给兜底）
 *   preferred_providers -> body provider_order（只排序，其余供应商照样能派）
 *   blocked_providers   -> body providers_blocked（硬拒，和统一屏蔽的 dashscope-cn 取并集）
 *   min_discount_pct    -> X-Min-Discount（凑不到返回 404，交给兜底，不会派给更贵的卖家）
 *   route_objective / price_tolerance_pct -> X-SI-Route-Objective / X-SI-Route-Tolerance-Pct
 * 只作用于没有自带路由的 Surplus 首发（模型目录付费档）；畅聊候选、畅聊兜底、状态栏、长期记忆各有自己的配置。
 */
/** Surplus 的标准模型名，例如 deepseek-v4.1-flash-1017 */
export const SurplusModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Surplus 模型名只能含字母、数字、点、下划线、连字符');

export const SurplusRoutingRuleSchema = z
  .object({
    surplus_model_id: SurplusModelIdSchema,
    allowed_providers: z.array(ProviderSlugSchema).max(20).default([]),
    preferred_providers: z.array(ProviderSlugSchema).max(20).default([]),
    blocked_providers: z.array(ProviderSlugSchema).max(20).default([]),
    min_discount_pct: z.number().int().min(1).max(100).nullable().default(null),
    /** 留空 = 全平台统一的可靠优先 */
    route_objective: SurplusRouteObjectiveSchema.nullable().default(null),
    /** 价格带：比最便宜的达标报价贵多少百分比以内按派单方式排（服务端会截断）；留空 = 统一的 100 */
    price_tolerance_pct: z.number().int().min(0).max(10_000).nullable().default(null),
    note: z.string().trim().max(200).default(''),
  })
  .superRefine((rule, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const lists = ['allowed_providers', 'preferred_providers', 'blocked_providers'] as const;
    for (const key of lists) {
      const duplicate = findDuplicate(rule[key]);
      if (duplicate) issue(key, `duplicate provider: ${duplicate}`);
    }
    if (
      lists.every((key) => rule[key].length === 0) &&
      rule.min_discount_pct === null &&
      rule.route_objective === null &&
      rule.price_tolerance_pct === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rule must set at least one provider list, discount floor or route preference',
      });
    }
    const blocked = new Set(rule.blocked_providers.map((slug) => slug.toLowerCase()));
    for (const key of ['allowed_providers', 'preferred_providers'] as const) {
      const conflicting = rule[key].find((slug) => blocked.has(slug.toLowerCase()));
      if (conflicting) issue(key, `provider cannot be both blocked and listed: ${conflicting}`);
    }
    if (rule.allowed_providers.length > 0) {
      const allowed = new Set(rule.allowed_providers.map((slug) => slug.toLowerCase()));
      const outside = rule.preferred_providers.find((slug) => !allowed.has(slug.toLowerCase()));
      if (outside) issue('preferred_providers', `preferred provider is not allowed: ${outside}`);
    }
  });

export type SurplusRoutingRule = z.infer<typeof SurplusRoutingRuleSchema>;

export const LlmProviderRoutingConfigSchema = z
  .object({
    rules: z.array(ProviderRoutingRuleSchema).max(100),
    /** Surplus 模型的路由规则；旧配置没有这个键时为空。 */
    surplus_rules: z.array(SurplusRoutingRuleSchema).max(100).default([]),
  })
  .superRefine((config, ctx) => {
    const duplicateModel = findDuplicate(config.rules.map((rule) => rule.openrouter_model_id));
    if (duplicateModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules'],
        message: `duplicate rule for model: ${duplicateModel}`,
      });
    }
    const duplicateSurplus = findDuplicate(
      config.surplus_rules.map((rule) => rule.surplus_model_id)
    );
    if (duplicateSurplus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['surplus_rules'],
        message: `duplicate rule for model: ${duplicateSurplus}`,
      });
    }
  });

export type ProviderRoutingRule = z.infer<typeof ProviderRoutingRuleSchema>;
export type LlmProviderRoutingConfig = z.infer<typeof LlmProviderRoutingConfigSchema>;

export const DEFAULT_LLM_PROVIDER_ROUTING_CONFIG: LlmProviderRoutingConfig = {
  rules: [],
  surplus_rules: [],
};

/** 某个 Surplus 模型命中的规则；未命中为 null（请求沿用全平台统一的可靠优先）。 */
export function resolveSurplusRoutingRule(
  config: LlmProviderRoutingConfig,
  surplusModelId: string
): SurplusRoutingRule | null {
  const normalized = surplusModelId.trim().toLowerCase();
  return (
    config.surplus_rules.find((rule) => rule.surplus_model_id.toLowerCase() === normalized) ?? null
  );
}

/** OpenRouter /chat/completions 请求体的顶层 provider 对象（只用到这三个字段）。 */
export interface OpenRouterProviderPreferences {
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  sort?: 'latency';
}

/** Fallback policy overrides only preference, never a model-specific block rule. */
export function fallbackProviderPreferences(
  preferences: OpenRouterProviderPreferences | null,
  preferred: readonly [string, string] | undefined
): OpenRouterProviderPreferences {
  const blocked = new Set(preferences?.ignore?.map((slug) => slug.toLowerCase()) ?? []);
  return {
    ...preferences,
    ...(preferred ? { order: preferred.filter((slug) => !blocked.has(slug.toLowerCase())) } : {}),
    sort: 'latency',
    allow_fallbacks: true,
  };
}

/**
 * 把某个模型命中的规则翻译成 OpenRouter provider routing 参数。
 * 未命中返回 null，调用方不加 provider 字段，行为与不配置时完全一致。
 */
export function resolveProviderPreferences(
  config: LlmProviderRoutingConfig,
  openRouterModelId: string
): OpenRouterProviderPreferences | null {
  const normalizedModelId = openRouterModelId.trim().toLowerCase();
  const rule = config.rules.find(
    (candidate) => candidate.openrouter_model_id.toLowerCase() === normalizedModelId
  );
  if (!rule) return null;

  const preferences: OpenRouterProviderPreferences = {};
  if (rule.preferred_providers.length > 0) {
    preferences.order = [...rule.preferred_providers];
    // 优先级是软干预：order 里的供应商试完后允许回落到其余供应商兜底。
    preferences.allow_fallbacks = true;
  }
  if (rule.blocked_providers.length > 0) {
    preferences.ignore = [...rule.blocked_providers];
  }
  return preferences.order || preferences.ignore ? preferences : null;
}

/**
 * 运营平台查 Surplus 某模型各供应商的公开报价与 24h 表现（GET /api/admin/model-providers/surplus/market）。
 * 折扣是相对外部直购价（多为 OpenRouter 价）；首字 / 可用率是全平台买家口径，不是我们自己的。
 */
export const SurplusProviderMarketRowSchema = z
  .object({
    provider: z.string().min(1).max(64),
    trusted: z.boolean(),
    /** 全平台统一屏蔽（SURPLUS_ALWAYS_BLOCKED_PROVIDERS），规则里选了也派不到 */
    always_blocked: z.boolean(),
    offers: z.number().int().nonnegative(),
    /** 在线且健康的卖家数 */
    available_offers: z.number().int().nonnegative(),
    best_discount_pct: z.number().finite().nullable(),
    median_discount_pct: z.number().finite().nullable(),
    ttft_p50_ms: z.number().finite().nonnegative().nullable(),
    uptime_pct: z.number().finite().nullable(),
  })
  .strict();

export const SurplusProviderMarketSchema = z
  .object({
    model: z.string().min(1).max(200),
    fetched_at: z.string().datetime(),
    performance_status: z.enum(['ok', 'failed']),
    providers: z.array(SurplusProviderMarketRowSchema).max(200),
  })
  .strict();

export type SurplusProviderMarketRow = z.infer<typeof SurplusProviderMarketRowSchema>;
export type SurplusProviderMarket = z.infer<typeof SurplusProviderMarketSchema>;
