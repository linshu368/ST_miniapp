import {
  DEFAULT_INVITE_REWARD_RULES,
  DEFAULT_INVITE_CENTER_CONFIG,
  DEFAULT_SYSTEM_INSTRUCTIONS,
} from './configDefaults';
import { configMetadata } from './configMetadata';
export {
  DEFAULT_INVITE_REWARD_RULES,
  DEFAULT_INVITE_CENTER_CONFIG,
  DEFAULT_SYSTEM_INSTRUCTIONS,
} from './configDefaults';
export { configMetadata } from './configMetadata';
import {
  LLM_RELAY_PROVIDER_CONFIG_KEY,
  LlmRelayProviderConfigSchema,
  CheckinTierCreditsSchema,
  CREATOR_REVIEW_PROMPT_KEY,
  CreatorReviewPromptSchema,
  DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
  DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  MEMORY_BAR_PROMPT_KEY,
  MemoryBarPromptSchema,
  STATUS_MEMORY_MODEL_CONFIG_KEY,
  StatusMemoryModelConfigSchema,
  CHAT_RECOVERY_CONFIG_KEY,
  ChatRecoveryConfigSchema,
  DRIVE_MODE_OPTIONS_KEY,
  DriveModesConfigSchema,
  FeatureFreeTrialLimitsSchema,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  FREE_ZONE_CONFIG_KEY,
  FreeZoneConfigSchema,
  ImagePlazaModelCatalogSchema,
  ImagePlazaShareTipConfigSchema,
  ImagePlazaTagConfigSchema,
  InstructionSlotRulesSchema,
  LlmModelProviderSchema,
  LlmPricingConfigSchema,
  LlmProviderRoutingConfigSchema,
  LobbyRankingParamsSchema,
  ModelCatalogSchema,
  normalizeCatalogModelInput,
  PaymentPlansRuntimeConfigSchema,
  ReplyStyleOptionsConfigSchema,
  STORY_MEMORY_CONFIG_KEY,
  STORY_MEMORY_PROMPT_KEY,
  StoryMemoryConfigSchema,
  StoryMemoryPromptSchema,
  VideoPlazaModelCatalogSchema,
  VIP_STRATEGY_CONFIG_KEYS,
  VipCheckinBonusConfigSchema,
  VipFeatureSwitchSchema,
  VipPlansConfigSchema,
  VipTextDiscountRateSchema,
  WordCountTiersConfigSchema,
} from '@miniapp/shared';
import { z } from 'zod';
import { normalizeVideoPlazaCatalogOptions } from './videoPlazaConfig';
export {
  getDefaultVideoPlazaModelOptions,
  normalizeVideoPlazaCatalogOptions,
} from './videoPlazaConfig';
export { LlmPricingConfigSchema };

export const managedConfigKeys = [
  'miniapp_new_user_signup_bonus_credits',
  'miniapp_checkin_new_user_credits',
  'miniapp_checkin_veteran_credits',
  'miniapp_payment_plans',
  'llm_model_catalog',
  'llm_pricing_config',
  'llm_provider_routing_config',
  LLM_RELAY_PROVIDER_CONFIG_KEY,
  FREE_ZONE_CONFIG_KEY,
  'system_instructions',
  CREATOR_REVIEW_PROMPT_KEY,
  'choice_rules',
  'reply_style_options',
  DRIVE_MODE_OPTIONS_KEY,
  'pref_word_count_tiers',
  STORY_MEMORY_CONFIG_KEY,
  STORY_MEMORY_PROMPT_KEY,
  MEMORY_BAR_PROMPT_KEY,
  STATUS_MEMORY_MODEL_CONFIG_KEY,
  CHAT_RECOVERY_CONFIG_KEY,
  'lobby_ranking_params',
  'miniapp_invite_reward_rules',
  'miniapp_invite_center_config',
  'miniapp_invite_entry_enabled',
  'image_plaza_model_catalog',
  'image_plaza_video_model_catalog',
  'image_plaza_share_tip',
  'image_plaza_tags',
  ...VIP_STRATEGY_CONFIG_KEYS,
] as const;

export type ManagedConfigKey = (typeof managedConfigKeys)[number];

/** 存 runtime_config.text_value 的 managed key；草稿 value 为 null */
export const TEXT_MANAGED_CONFIG_KEYS = [
  CREATOR_REVIEW_PROMPT_KEY,
  STORY_MEMORY_PROMPT_KEY,
  MEMORY_BAR_PROMPT_KEY,
  'system_instructions',
] as const;
export type TextManagedConfigKey = (typeof TEXT_MANAGED_CONFIG_KEYS)[number];

export function isTextManagedConfig(key: ManagedConfigKey): key is TextManagedConfigKey {
  return (TEXT_MANAGED_CONFIG_KEYS as readonly string[]).includes(key);
}

const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

// 状态栏、记忆栏不再由正文模型输出：模板里只有选项一个规则槽位。
const REQUIRED_INSTRUCTION_PLACEHOLDERS = [
  '{{CHOICE_RULES}}',
  '{{WORD_COUNT}}',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
] as const;

export const SystemInstructionsSchema = z
  .string()
  .trim()
  .min(1, '平台规则不能为空')
  .superRefine((value, ctx) => {
    for (const placeholder of REQUIRED_INSTRUCTION_PLACEHOLDERS) {
      if (!value.includes(placeholder)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `缺少占位符 ${placeholder}`,
        });
      }
    }
  });

const EditableModelCatalogModelSchema = z.preprocess(
  normalizeCatalogModelInput,
  z.object({
    id: z.string(),
    provider: LlmModelProviderSchema,
    provider_model_id: z.string(),
    openrouter_model_id: z.string(),
    display_name: z.string(),
    tagline: z.string(),
    first_token_timeout_ms: z.number().default(4000),
    enabled: z.boolean(),
    sort_order: z.number().int().nonnegative(),
  })
);

const EditableModelCatalogTierSchema = z.object({
  tier: z.enum(['light', 'standard', 'premium']),
  label: z.string(),
  color: z.string(),
  cost_hint: z.string(),
  sort_order: z.number().int().nonnegative(),
  models: z.array(EditableModelCatalogModelSchema),
});

/** 模型目录「免费畅聊」板块：编辑中允许空值，保存时由 shared 的严格 schema 校验 */
const EditableCatalogFreeZoneModelSchema = z.object({
  id: z.string(),
  provider: LlmModelProviderSchema,
  provider_model_id: z.string(),
  display_name: z.string(),
  tagline: z.string().default(''),
  family: z.string().default(''),
  benchmark_tier: z.enum(['light', 'standard', 'premium']).default('standard'),
  first_token_timeout_ms: z.number().default(4000),
  turns_per_24h: z.number().nullable().default(null),
  enabled: z.boolean().default(true),
});

export const EditableModelCatalogSchema = z.object({
  fallback_provider_routes: z
    .array(
      z.object({
        model_id: z.string(),
        preferred_providers: z.tuple([z.string(), z.string()]),
      })
    )
    .optional(),
  fallback_model_id: z.string().default(FIRST_TOKEN_FALLBACK_MODEL_ID),
  first_token_deadline_ms: z.number().default(DEFAULT_FIRST_TOKEN_DEADLINE_MS),
  fallback_timeout_ms: z.number().default(DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS),
  first_token_timeout_rate_target: z.number().default(0.01),
  default_model_id: z.string(),
  tiers: z.array(EditableModelCatalogTierSchema),
  // 漏了这一项时 zod 会把整块丢掉：编辑器每次渲染都按解析结果显示，新加的免费模型会立刻消失
  free_zone_models: z.array(EditableCatalogFreeZoneModelSchema).default([]),
});

// 仅验证编辑结构，允许清空、重复 ID 等中间态；保存仍使用 shared 的严格 schema。
export const EditableImagePlazaTagConfigSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    sort_order: z.number(),
    group_id: z.string().optional(),
    group_label: z.string().optional(),
    group_sort_order: z.number().optional(),
    group_layout: z.enum(['chips', 'grid']).optional(),
  })
);

/**
 * 裂变邀请三个 config 的 zod 口径与 105 迁移的 DB 校验函数
 * （admin.validate_invite_reward_rules / validate_invite_center_config）保持一致：
 * 前端先给可读报错，DB 校验做最终兜底。
 */
export const InviteRewardRuleSchema = z.object({
  rule_key: z.string().trim().min(1, 'rule_key 不能为空').max(64, 'rule_key 不能超过 64 个字符'),
  credits: z.number().int('奖励星尘必须是整数').positive('奖励星尘必须大于 0'),
  enabled: z.boolean(),
  threshold_rounds: z.number().int('达标轮数必须是整数').min(1, '达标轮数最小值为1').optional(),
});

export const InviteRewardRulesSchema = z
  .object({
    total_cap_credits: z.number().int('累计上限必须是整数').positive('累计上限必须大于 0'),
    rules: z.array(InviteRewardRuleSchema),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const rule of value.rules) {
      if (seen.has(rule.rule_key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rule_key 重复：${rule.rule_key}`,
        });
      }
      seen.add(rule.rule_key);
    }
  });

export type InviteRewardRulesConfig = z.infer<typeof InviteRewardRulesSchema>;

/** rule_key → 运营台展示名；未收录的 key 各处回落展示原始 rule_key。 */
export const INVITE_RULE_KEY_LABELS: Record<string, string> = {
  invitee_registered: '被邀请人完成注册',
  invitee_chat_rounds: '被邀请人完成文本对话',
  invitee_first_paid: '被邀请人首次付费',
};

export const InviteCenterConfigSchema = z.object({
  // 允许空串：海报未发布时 C 端降级隐藏。
  poster_url: z.string(),
  copy_templates: z
    .array(
      z.string().refine((template) => {
        const trimmed = template.trim();
        return trimmed.length >= 1 && trimmed.length <= 1000;
      }, '每条文案不能为空且不超过 1000 字')
    )
    .min(1, '文案库至少保留 1 条文案'),
});

export type InviteCenterConfig = z.infer<typeof InviteCenterConfigSchema>;

export const InviteEntryEnabledSchema = z.boolean();

export const configSchemas: Record<ManagedConfigKey, z.ZodTypeAny> = {
  miniapp_new_user_signup_bonus_credits: nonnegativeInteger,
  miniapp_checkin_new_user_credits: CheckinTierCreditsSchema,
  miniapp_checkin_veteran_credits: CheckinTierCreditsSchema,
  miniapp_payment_plans: PaymentPlansRuntimeConfigSchema,
  llm_model_catalog: ModelCatalogSchema,
  [LLM_RELAY_PROVIDER_CONFIG_KEY]: LlmRelayProviderConfigSchema,
  llm_pricing_config: LlmPricingConfigSchema,
  llm_provider_routing_config: LlmProviderRoutingConfigSchema,
  [FREE_ZONE_CONFIG_KEY]: FreeZoneConfigSchema,
  system_instructions: SystemInstructionsSchema,
  [CREATOR_REVIEW_PROMPT_KEY]: CreatorReviewPromptSchema,
  choice_rules: InstructionSlotRulesSchema,
  reply_style_options: ReplyStyleOptionsConfigSchema,
  [DRIVE_MODE_OPTIONS_KEY]: DriveModesConfigSchema,
  pref_word_count_tiers: WordCountTiersConfigSchema,
  [STORY_MEMORY_CONFIG_KEY]: StoryMemoryConfigSchema,
  [STORY_MEMORY_PROMPT_KEY]: StoryMemoryPromptSchema,
  [MEMORY_BAR_PROMPT_KEY]: MemoryBarPromptSchema,
  [STATUS_MEMORY_MODEL_CONFIG_KEY]: StatusMemoryModelConfigSchema,
  [CHAT_RECOVERY_CONFIG_KEY]: ChatRecoveryConfigSchema,
  lobby_ranking_params: LobbyRankingParamsSchema,
  miniapp_invite_reward_rules: InviteRewardRulesSchema,
  miniapp_invite_center_config: InviteCenterConfigSchema,
  miniapp_invite_entry_enabled: InviteEntryEnabledSchema,
  image_plaza_model_catalog: ImagePlazaModelCatalogSchema,
  image_plaza_video_model_catalog: VideoPlazaModelCatalogSchema.transform(
    normalizeVideoPlazaCatalogOptions
  ),
  image_plaza_share_tip: ImagePlazaShareTipConfigSchema,
  image_plaza_tags: ImagePlazaTagConfigSchema,
  vip_purchase_enabled: VipFeatureSwitchSchema,
  vip_reminders_enabled: VipFeatureSwitchSchema,
  vip_plans_config: VipPlansConfigSchema,
  vip_text_discount_rate: VipTextDiscountRateSchema,
  vip_checkin_bonus_config: VipCheckinBonusConfigSchema,
  feature_free_trial_limits: FeatureFreeTrialLimitsSchema,
};

export function parseManagedConfig(key: ManagedConfigKey, value: unknown): unknown {
  return configSchemas[key].parse(value);
}

export function resolveManagedWorkingValue(input: {
  key: ManagedConfigKey;
  draft: { value: unknown; text_value: string | null } | null | undefined;
  config: { value: unknown; text_value: string | null } | null | undefined;
}): unknown {
  const fallback = configMetadata[input.key].defaultValue;
  if (isTextManagedConfig(input.key)) {
    return input.draft?.text_value ?? input.config?.text_value ?? fallback;
  }
  return structuredClone(input.draft?.value ?? input.config?.value ?? fallback);
}

/** Keep incomplete rows intact while operators are typing; validate on save. */
export const EditableReplyStyleOptionsConfigSchema = z
  .object({
    options: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          marker: z.string(),
          rules: z.string(),
          enabled: z.boolean(),
        })
        .strict()
    ),
  })
  .strict();
