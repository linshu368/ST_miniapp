import {
  DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  DEFAULT_FEATURE_FREE_TRIAL_LIMIT,
  DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  DEFAULT_LOBBY_PINNED_CHARACTERS,
  DEFAULT_LOBBY_RANKING_PARAMS,
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  FeatureFreeTrialLimitsSchema,
  FreeQuotaExhaustedDialogConfigSchema,
  LlmPricingConfigSchema,
  LlmProviderRoutingConfigSchema,
  LobbyPinnedCharactersSchema,
  LobbyRankingParamsSchema,
  MAX_FEATURE_FREE_TRIAL_LIMIT,
  MediaFeatureFreeTrialLimitSchema,
  ModelCatalogSchema,
  normalizeCatalogModelInput,
  PaymentPlansSchema,
  PaymentPromptDialogConfigSchema,
  RechargePageConfigSchema,
  VIP_STRATEGY_CONFIG_KEYS,
  VipCheckinBonusConfigSchema,
  VipFeatureSwitchSchema,
  VipPlansConfigSchema,
  VipTextDiscountRateSchema,
  WordCountTiersConfigSchema,
} from '@miniapp/shared';
import { z } from 'zod';

export const managedConfigKeys = [
  'miniapp_new_user_signup_bonus_credits',
  'miniapp_daily_checkin_bonus_credits',
  'miniapp_character_free_chat_quota_limit',
  'miniapp_payment_plans',
  'miniapp_recharge_page_config',
  'miniapp_payment_prompt_dialog_config',
  'miniapp_free_quota_exhausted_dialog_config',
  'llm_model_catalog',
  'llm_pricing_config',
  'llm_provider_routing_config',
  'system_fallback_character_id',
  'system_instructions',
  'pref_word_count_tiers',
  'lobby_ranking_params',
  'lobby_pinned_characters',
  'miniapp_invite_reward_rules',
  'miniapp_invite_center_config',
  'miniapp_invite_entry_enabled',
  'image_generation_enabled',
  'image_generation_credits',
  'image_price_label',
  'image_text_model_config',
  'image_prompt_policy',
  'image_default_art_style',
  'image_description_system_prompt',
  'image_width',
  'image_height',
  'image_max_prompt_chars',
  'image_max_output_bytes',
  'image_prompt_over_limit_hint',
  'image_description_failed_hint',
  'image_generation_failed_hint',
  'image_failed_unknown_hint',
  'image_advanced_enabled',
  'image_advanced_generation_credits',
  'image_advanced_price_label',
  'image_advanced_provider_config',
  'media_feature_free_trial_limit',
  ...VIP_STRATEGY_CONFIG_KEYS,
] as const;

export type ManagedConfigKey = (typeof managedConfigKeys)[number];

/** 存 runtime_config.text_value 的 managed key；草稿 value 为 null */
export const TEXT_MANAGED_CONFIG_KEYS = [
  'system_instructions',
  'image_description_system_prompt',
] as const;
export type TextManagedConfigKey = (typeof TEXT_MANAGED_CONFIG_KEYS)[number];

export function isTextManagedConfig(key: ManagedConfigKey): key is TextManagedConfigKey {
  return (TEXT_MANAGED_CONFIG_KEYS as readonly string[]).includes(key);
}

const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
export { LlmPricingConfigSchema };

const REQUIRED_INSTRUCTION_PLACEHOLDERS = [
  '{{WORD_COUNT}}',
  '{{INTERACTION_MODE}}',
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
    openrouter_model_id: z.string(),
    display_name: z.string(),
    tagline: z.string(),
    is_free: z.boolean(),
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

export const EditableModelCatalogSchema = z.object({
  default_model_id: z.string(),
  tiers: z.array(EditableModelCatalogTierSchema),
});

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

export const ImageTextModelConfigSchema = z
  .object({
    url: z.string().trim().max(2048, '请求 URL 不能超过 2048 个字符'),
    api_key: z.string().trim().max(4096, 'API Key 不能超过 4096 个字符'),
    model: z.string().trim().max(256, '模型名称不能超过 256 个字符'),
  })
  .superRefine((value, ctx) => {
    const fields = [value.url, value.api_key, value.model];
    if (fields.every((field) => field === '')) return;
    if (fields.some((field) => field === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'URL、API Key、模型名称必须整组填写' });
      return;
    }
    try {
      const url = new URL(value.url);
      if (url.protocol !== 'https:') throw new Error('not https');
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: '请求 URL 必须是有效的 HTTPS 地址',
      });
    }
  });

export type ImageTextModelConfig = z.infer<typeof ImageTextModelConfigSchema>;

export const AdvancedImageProviderConfigSchema = z
  .union([
    z.object({}).strict(),
    z
      .object({
        provider: z.enum(['liaobots_grok', 'replicate_z']),
        model: z.string().trim().min(1, '模型名称不能为空').max(256, '模型名称不能超过 256 个字符'),
      })
      .strict(),
  ])
  .describe('Advanced image provider config');

export type AdvancedImageProviderConfig = z.infer<typeof AdvancedImageProviderConfigSchema>;

/** 与 105 迁移的 runtime_config seed 完全一致。 */
export const DEFAULT_INVITE_REWARD_RULES: InviteRewardRulesConfig = {
  total_cap_credits: 2200,
  rules: [
    { rule_key: 'invitee_registered', credits: 200, enabled: false },
    { rule_key: 'invitee_chat_rounds', credits: 200, enabled: true, threshold_rounds: 3 },
    { rule_key: 'invitee_first_paid', credits: 2000, enabled: false },
  ],
};

export const DEFAULT_INVITE_CENTER_CONFIG: InviteCenterConfig = {
  poster_url: '',
  copy_templates: [
    '我在这里发现了超多有趣的角色，快来和我一起聊！点击专属链接注册，我们都能拿星尘奖励：{link}',
  ],
};

export const DEFAULT_SYSTEM_INSTRUCTIONS = [
  'Roleplay System Instructions',
  '',
  '{{INTERACTION_MODE}}',
  '',
  '输出篇幅为 {{WORD_COUNT}} 字，段落之间使用空行隔开，仅使用简体中文。',
  '',
  '用户个人偏好为：',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
].join('\n');

export const configSchemas: Record<ManagedConfigKey, z.ZodTypeAny> = {
  miniapp_new_user_signup_bonus_credits: nonnegativeInteger,
  miniapp_daily_checkin_bonus_credits: nonnegativeInteger,
  miniapp_character_free_chat_quota_limit: positiveInteger,
  miniapp_payment_plans: PaymentPlansSchema,
  miniapp_recharge_page_config: RechargePageConfigSchema,
  miniapp_payment_prompt_dialog_config: PaymentPromptDialogConfigSchema,
  miniapp_free_quota_exhausted_dialog_config: FreeQuotaExhaustedDialogConfigSchema,
  llm_model_catalog: ModelCatalogSchema,
  llm_pricing_config: LlmPricingConfigSchema,
  llm_provider_routing_config: LlmProviderRoutingConfigSchema,
  system_fallback_character_id: z.string().uuid(),
  system_instructions: SystemInstructionsSchema,
  pref_word_count_tiers: WordCountTiersConfigSchema,
  lobby_ranking_params: LobbyRankingParamsSchema,
  lobby_pinned_characters: LobbyPinnedCharactersSchema,
  miniapp_invite_reward_rules: InviteRewardRulesSchema,
  miniapp_invite_center_config: InviteCenterConfigSchema,
  miniapp_invite_entry_enabled: InviteEntryEnabledSchema,
  image_generation_enabled: z.boolean(),
  image_generation_credits: positiveInteger,
  image_price_label: z.string().trim().min(1, '价格文案不能为空').max(200),
  image_text_model_config: ImageTextModelConfigSchema,
  image_prompt_policy: z.string().trim().min(1, '图片 prompt 策略不能为空').max(1000),
  image_default_art_style: z.string().trim().min(1, '画风说明不能为空').max(1000),
  image_description_system_prompt: z
    .string()
    .trim()
    .min(1, '图片描述 system prompt 不能为空')
    .max(12000, '图片描述 system prompt 不能超过 12000 个字符'),
  image_width: positiveInteger.min(256).max(4096),
  image_height: positiveInteger.min(256).max(4096),
  image_max_prompt_chars: z.literal(1000),
  image_max_output_bytes: positiveInteger.min(1048576).max(52428800),
  image_prompt_over_limit_hint: z.string().trim().min(1).max(200),
  image_description_failed_hint: z.string().trim().min(1).max(200),
  image_generation_failed_hint: z.string().trim().min(1).max(200),
  image_failed_unknown_hint: z.string().trim().min(1).max(200),
  image_advanced_enabled: z.boolean(),
  image_advanced_generation_credits: positiveInteger,
  image_advanced_price_label: z.string().trim().min(1, '价格文案不能为空').max(200),
  image_advanced_provider_config: AdvancedImageProviderConfigSchema,
  media_feature_free_trial_limit: MediaFeatureFreeTrialLimitSchema,
  vip_purchase_enabled: VipFeatureSwitchSchema,
  vip_reminders_enabled: VipFeatureSwitchSchema,
  vip_plans_config: VipPlansConfigSchema,
  vip_text_discount_rate: VipTextDiscountRateSchema,
  vip_checkin_bonus_config: VipCheckinBonusConfigSchema,
  feature_free_trial_limits: FeatureFreeTrialLimitsSchema,
};

export const configMetadata: Record<
  ManagedConfigKey,
  { label: string; description: string; defaultValue: unknown }
> = {
  miniapp_new_user_signup_bonus_credits: {
    label: '新用户赠送星尘',
    description: '新用户首次进入时一次性赠送的 bonus 星尘。',
    defaultValue: 398,
  },
  miniapp_daily_checkin_bonus_credits: {
    label: '每日签到奖励',
    description: '每次签到的基础专项星尘。有效 VIP 的加成由「VIP策略」决定。',
    defaultValue: 60,
  },
  miniapp_character_free_chat_quota_limit: {
    label: '角色卡免费对话轮次',
    description: '免费模型在单张角色卡上可免费用的对话轮次；超出后按扣费逻辑计费。',
    defaultValue: DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  },
  miniapp_payment_plans: {
    label: '充值套餐',
    description: '星尘商店展示并用于下单校验的正式套餐。',
    defaultValue: [],
  },
  miniapp_recharge_page_config: {
    label: '充值页面配置',
    description: '星尘商店的标题、说明、支付按钮文字、主题色，以及订单等待页的到账提示文案。',
    defaultValue: DEFAULT_RECHARGE_PAGE_CONFIG,
  },
  miniapp_payment_prompt_dialog_config: {
    label: '支付提示弹窗',
    description: '打开外部支付页前展示的 VPN 提醒文案、启用状态和统一强调色。',
    defaultValue: DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  },
  miniapp_free_quota_exhausted_dialog_config: {
    label: '免费额度耗尽轻提示',
    description:
      '角色卡免费额度耗尽后，在该轮回复下方展示的轻提示文案；使用 {characterName} 插入当前角色名。',
    defaultValue: DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  },
  llm_model_catalog: {
    label: '模型目录',
    description: '用户可选择的 OpenRouter 模型、档位、是否免费与默认模型。',
    defaultValue: {
      default_model_id: 'gemini-flash-lite',
      tiers: [
        {
          tier: 'light',
          label: '轻量',
          color: '#4ade80',
          cost_hint: '适合日常对话',
          sort_order: 1,
          models: [
            {
              id: 'gemini-flash-lite',
              openrouter_model_id: 'google/gemini-3.1-flash-lite',
              display_name: 'Gemini Flash Lite',
              tagline: '适合日常角色对话，回复快、消耗低。',
              is_free: false,
              enabled: true,
              sort_order: 1,
            },
          ],
        },
      ],
    },
  },
  llm_pricing_config: {
    label: 'LLM 计费参数',
    description: '每次成功生成的固定扣费标准（免费额度用尽 / 轻量 / 标准 / 旗舰）。',
    defaultValue: {
      fixedDeduction: {
        freeQuotaExhausted: 10,
        light: 15,
        standard: 30,
        premium: 50,
      },
    },
  },
  llm_provider_routing_config: {
    label: '模型供应商路由',
    description:
      '按「模型 × 供应商」控制 OpenRouter 路由：屏蔽列表写入 provider.ignore；优先列表写入 provider.order 并允许兜底回落。规则只作用于所填模型，未配置的模型不受影响。',
    defaultValue: DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  },
  system_fallback_character_id: {
    label: '系统兜底角色',
    description: '角色不可用时使用的系统兜底角色 UUID。',
    defaultValue: '',
  },
  system_instructions: {
    label: '平台规则模板',
    description:
      '自研引擎每轮注入的平台规则（markdown）。须含 {{WORD_COUNT}} / {{INTERACTION_MODE}} / {{USER_CUSTOM_INSTRUCTIONS}}；编辑与回滚均发布为新快照。',
    defaultValue: DEFAULT_SYSTEM_INSTRUCTIONS,
  },
  pref_word_count_tiers: {
    label: '回复长度档位',
    description:
      '生成偏好「回复长度」的档位表：可增删档位、改按钮文案与列布局；prompt_value 注入 {{WORD_COUNT}}。',
    defaultValue: DEFAULT_WORD_COUNT_TIERS_CONFIG,
  },
  lobby_ranking_params: {
    label: '推荐页排序参数',
    description:
      '首页「推荐」v3 打分口径：统计窗口、轮次上限、会话切分与回访窗口、D30/R48 权重、样本门槛与归一化分位。改动在下一次排序刷新（每 24 小时）后生效。',
    defaultValue: DEFAULT_LOBBY_RANKING_PARAMS,
  },
  lobby_pinned_characters: {
    label: '推荐页固定前八',
    description:
      '首页「推荐」页最前面的固定位，最多 8 张、按此处顺序展示，同时拿到金框。第九张起仍按排序分。留空表示不固定，完全交给排序分。发布后约 1 分钟内生效。',
    defaultValue: DEFAULT_LOBBY_PINNED_CHARACTERS,
  },
  miniapp_invite_reward_rules: {
    label: '裂变邀请奖励规则',
    description:
      '裂变邀请的奖励规则：total_cap_credits 为单个下级用户累计奖励上限；rule_key 发布后不可改名（发放流水引用它做幂等键），金额与开关可随时发布调整。',
    defaultValue: DEFAULT_INVITE_REWARD_RULES,
  },
  miniapp_invite_center_config: {
    label: '裂变邀请素材',
    description:
      '邀请中心素材：poster_url 为已发布海报图（2160×3840，支持直接上传 PNG/JPG/WEBP，也可贴 URL）；copy_templates 为已发布文案库（C 端刷新按钮轮换来源），{link} 会被替换为用户专属链接。',
    defaultValue: DEFAULT_INVITE_CENTER_CONFIG,
  },
  miniapp_invite_entry_enabled: {
    label: '裂变邀请入口开关',
    description:
      '裂变邀请入口总开关：关闭时 C 端隐藏邀请中心全部入口。生产环境先关后开，代码上线不等于功能上线。',
    defaultValue: false,
  },
  image_generation_enabled: {
    label: '图片生成入口开关',
    description: '关闭时不受理新图片任务，已受理任务继续收口。',
    defaultValue: false,
  },
  image_generation_credits: {
    label: '单张图片星尘价格',
    description: '单张图片成功生成并结算后扣除的星尘数。',
    defaultValue: 50,
  },
  image_price_label: {
    label: '图片价格展示文案',
    description: '图片生成确认按钮展示的价格文案。',
    defaultValue: '50 星尘',
  },
  image_text_model_config: {
    label: '图片文本模型',
    description:
      '图片描述写稿与中译英共用的 OpenRouter/OpenAI-compatible 模型。OpenRouter URL 使用 Authorization Bearer 鉴权并启用 reasoning；三项留空时回退当前 DeepSeek 配置。',
    defaultValue: { url: '', api_key: '', model: '' },
  },
  image_prompt_policy: {
    label: '图片 Prompt 策略',
    description: '追加到生图 provider prompt 的安全与内容策略，最长 1000 字。',
    defaultValue: '仅生成健康向、可公开发布的单人/场景竖图，不包含露骨、暴力或未成年人性化内容。',
  },
  image_default_art_style: {
    label: '默认画风说明',
    description: '默认分镜写稿输入及生图 prompt 使用的画风说明，最长 1000 字。',
    defaultValue: '精致二次元竖幅插画，柔和光影，健康公开发布',
  },
  image_description_system_prompt: {
    label: '图片描述 System Prompt',
    description:
      '默认分镜写稿模型使用的 system prompt，保存到 runtime_config.text_value；缺失时后端回退内置版本。',
    defaultValue:
      '你是视觉分镜师。请根据角色视觉锚点和最近对话，输出一段自然流畅、适合生成图片的中文画面描述，不要输出解释或分析。',
  },
  image_width: {
    label: '图片宽度',
    description: '生成图片宽度（像素），范围 256~4096。',
    defaultValue: 1024,
  },
  image_height: {
    label: '图片高度',
    description: '生成图片高度（像素），范围 256~4096。',
    defaultValue: 1536,
  },
  image_max_prompt_chars: {
    label: '图片描述字数上限',
    description: '必须固定为 1000，与 shared 对外契约保持一致。',
    defaultValue: 1000,
  },
  image_max_output_bytes: {
    label: '图片文件大小上限',
    description: '后端允许下载并转存的最大图片字节数，范围 1MB~50MB。',
    defaultValue: 15728640,
  },
  image_prompt_over_limit_hint: {
    label: '描述超限提示',
    description: '用户图片描述超过字数限制时展示的提示。',
    defaultValue: '描述最多 1000 字，请删减后再生成。',
  },
  image_description_failed_hint: {
    label: '写稿失败提示',
    description: '图片描述模型调用失败时展示的提示。',
    defaultValue: '这次没有写出合适的画面描述，请稍后重试。',
  },
  image_generation_failed_hint: {
    label: '图片明确失败提示',
    description: '图片 provider 明确返回失败时展示的提示。',
    defaultValue: '图片生成没有成功，本次不消耗星尘。',
  },
  image_failed_unknown_hint: {
    label: '图片模糊失败提示',
    description: '外部平台结果未知、禁止自动重试时展示的提示。',
    defaultValue: '外部平台没有确认成功，本次不消耗星尘。',
  },
  image_advanced_enabled: {
    label: '高级图片入口开关',
    description: '控制 C 端高级图片入口；关闭时高级图片请求会被后端拦截。',
    defaultValue: false,
  },
  image_advanced_generation_credits: {
    label: '高级图片单张价格',
    description: '高级图片成功生成并结算后扣除的 main 星尘数。',
    defaultValue: 120,
  },
  image_advanced_price_label: {
    label: '高级图片价格文案',
    description: '高级图片确认按钮展示的价格文案，需要与扣费额保持一致。',
    defaultValue: '120 星尘',
  },
  image_advanced_provider_config: {
    label: '高级图片 Provider 配置',
    description:
      '高级图片生成使用的 provider 与 model；留空表示高级图片不可用。鉴权密钥仍由后端环境变量提供。',
    defaultValue: {},
  },
  media_feature_free_trial_limit: {
    label: '媒体免费轮次次数',
    description: `语音与基础图片各自可用的免费成功次数，范围 1~${MAX_FEATURE_FREE_TRIAL_LIMIT}。高级图片不参与免费轮次。`,
    defaultValue: DEFAULT_FEATURE_FREE_TRIAL_LIMIT,
  },
  vip_purchase_enabled: {
    label: 'VIP 购买开关',
    description: '关闭时不能创建新的 VIP 订单。已创建订单仍按自己的商品快照履约。',
    defaultValue: false,
  },
  vip_reminders_enabled: {
    label: 'VIP 到期提醒开关',
    description: '只控制提醒是否写入。提前天数、文案和时区不在这里配置，默认保持关闭。',
    defaultValue: false,
  },
  vip_plans_config: {
    label: '周卡与月卡商品',
    description: '价格使用整数分。周卡赠送固定为 0。发布后只影响新创建的订单。',
    defaultValue: DEFAULT_VIP_PLANS_CONFIG,
  },
  vip_text_discount_rate: {
    label: 'VIP 文本折扣率',
    description: '大于 0 且不超过 1。生成受理时固化，不重算已经受理的请求。',
    defaultValue: DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  },
  vip_checkin_bonus_config: {
    label: 'VIP 签到加成',
    description: '与基础奖励相同，或在固定模式下填写非负整数。一次签到只读取一份策略。',
    defaultValue: DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  },
  feature_free_trial_limits: {
    label: '媒体免费次数',
    description: '语音和初级图片分别配置，整数 0 到 20。0 表示关闭该功能的免费体验。',
    defaultValue: DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  },
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
