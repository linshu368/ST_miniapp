import { z } from 'zod';

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

export const LlmProviderRoutingConfigSchema = z
  .object({
    rules: z.array(ProviderRoutingRuleSchema).max(100),
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
  });

export type ProviderRoutingRule = z.infer<typeof ProviderRoutingRuleSchema>;
export type LlmProviderRoutingConfig = z.infer<typeof LlmProviderRoutingConfigSchema>;

export const DEFAULT_LLM_PROVIDER_ROUTING_CONFIG: LlmProviderRoutingConfig = { rules: [] };

/** OpenRouter /chat/completions 请求体的顶层 provider 对象（只用到这三个字段）。 */
export interface OpenRouterProviderPreferences {
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
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
