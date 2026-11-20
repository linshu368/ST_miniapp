import {
  CheckinTierCreditsSchema,
  CREATOR_REVIEW_PROMPT_KEY,
  CreatorReviewPromptSchema,
  DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  DEFAULT_CHECKIN_NEW_USER_CREDITS,
  DEFAULT_CHECKIN_VETERAN_CREDITS,
  DEFAULT_CREATOR_REVIEW_PROMPT,
  DEFAULT_DRIVE_MODES_CONFIG,
  DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  DEFAULT_FREE_ZONE_CONFIG,
  DEFAULT_IMAGE_PLAZA_PRICING_FACTORS,
  DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  DEFAULT_LOBBY_RANKING_PARAMS,
  DEFAULT_STORY_MEMORY_CONFIG,
  DEFAULT_STORY_MEMORY_PROMPT,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  DRIVE_MODE_OPTIONS_KEY,
  DriveModesConfigSchema,
  FeatureFreeTrialLimitsSchema,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  FREE_ZONE_CONFIG_KEY,
  FreeQuotaExhaustedDialogConfigSchema,
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
import { createDefaultVideoCatalog, normalizeVideoPlazaCatalogOptions } from './videoPlazaConfig';
export {
  getDefaultVideoPlazaModelOptions,
  normalizeVideoPlazaCatalogOptions,
} from './videoPlazaConfig';
export { LlmPricingConfigSchema };

export const managedConfigKeys = [
  'miniapp_new_user_signup_bonus_credits',
  'miniapp_checkin_new_user_credits',
  'miniapp_checkin_veteran_credits',
  'miniapp_character_free_chat_quota_limit',
  'miniapp_payment_plans',
  'miniapp_free_quota_exhausted_dialog_config',
  'llm_model_catalog',
  'llm_pricing_config',
  'llm_provider_routing_config',
  FREE_ZONE_CONFIG_KEY,
  'system_instructions',
  CREATOR_REVIEW_PROMPT_KEY,
  'choice_rules',
  'memory_rules',
  'reply_style_options',
  DRIVE_MODE_OPTIONS_KEY,
  'pref_word_count_tiers',
  STORY_MEMORY_CONFIG_KEY,
  STORY_MEMORY_PROMPT_KEY,
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
  'system_instructions',
] as const;
export type TextManagedConfigKey = (typeof TEXT_MANAGED_CONFIG_KEYS)[number];

export function isTextManagedConfig(key: ManagedConfigKey): key is TextManagedConfigKey {
  return (TEXT_MANAGED_CONFIG_KEYS as readonly string[]).includes(key);
}

const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

// 状态栏不再由正文模型输出：{{STATUS_RULES}} 不再必填（后端渲染为空）。
const REQUIRED_INSTRUCTION_PLACEHOLDERS = [
  '{{CHOICE_RULES}}',
  '{{MEMORY_RULES}}',
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
    is_free: z.boolean(),
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

/**
 * Safe Admin fallback only. The authoritative published template remains the
 * managed runtime value; this fallback keeps a new/empty environment from
 * offering the retired INTERACTION_MODE contract.
 */
export const DEFAULT_SYSTEM_INSTRUCTIONS = [
  '# Roleplay System Instructions',
  '',
  '只输出最终展示内容；不得替用户决定行动。剧情正文始终先输出，开启模块按选项、记忆区的固定顺序追加，关闭模块必须完整省略标签、标题和占位内容。',
  '',
  '## 选项槽位',
  '{{CHOICE_RULES}}',
  '',
  '## 记忆区槽位',
  '{{MEMORY_RULES}}',
  '',
  '## 用户个人偏好',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
  '',
  '剧情正文篇幅为 {{WORD_COUNT}} 字，仅使用简体中文。',
].join('\n');

export const configSchemas: Record<ManagedConfigKey, z.ZodTypeAny> = {
  miniapp_new_user_signup_bonus_credits: nonnegativeInteger,
  miniapp_checkin_new_user_credits: CheckinTierCreditsSchema,
  miniapp_checkin_veteran_credits: CheckinTierCreditsSchema,
  miniapp_character_free_chat_quota_limit: positiveInteger,
  miniapp_payment_plans: PaymentPlansRuntimeConfigSchema,
  miniapp_free_quota_exhausted_dialog_config: FreeQuotaExhaustedDialogConfigSchema,
  llm_model_catalog: ModelCatalogSchema,
  llm_pricing_config: LlmPricingConfigSchema,
  llm_provider_routing_config: LlmProviderRoutingConfigSchema,
  [FREE_ZONE_CONFIG_KEY]: FreeZoneConfigSchema,
  system_instructions: SystemInstructionsSchema,
  [CREATOR_REVIEW_PROMPT_KEY]: CreatorReviewPromptSchema,
  choice_rules: InstructionSlotRulesSchema,
  memory_rules: InstructionSlotRulesSchema,
  reply_style_options: ReplyStyleOptionsConfigSchema,
  [DRIVE_MODE_OPTIONS_KEY]: DriveModesConfigSchema,
  pref_word_count_tiers: WordCountTiersConfigSchema,
  [STORY_MEMORY_CONFIG_KEY]: StoryMemoryConfigSchema,
  [STORY_MEMORY_PROMPT_KEY]: StoryMemoryPromptSchema,
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

export const configMetadata: Record<
  ManagedConfigKey,
  { label: string; description: string; defaultValue: unknown }
> = {
  miniapp_new_user_signup_bonus_credits: {
    label: '新用户赠送星尘',
    description: '新用户首次进入时一次性赠送的 bonus 星尘。',
    defaultValue: 398,
  },
  miniapp_checkin_new_user_credits: {
    label: '新用户签到奖励',
    description: '非 VIP 且注册≤14 天的每日签到专项星尘绝对额。',
    defaultValue: DEFAULT_CHECKIN_NEW_USER_CREDITS,
  },
  miniapp_checkin_veteran_credits: {
    label: '老用户签到奖励',
    description: '非 VIP 且注册>14 天的每日签到专项星尘绝对额。',
    defaultValue: DEFAULT_CHECKIN_VETERAN_CREDITS,
  },
  miniapp_character_free_chat_quota_limit: {
    label: '角色卡免费对话轮次',
    description: '免费模型在单张角色卡上可免费用的对话轮次；超出后按扣费逻辑计费。',
    defaultValue: DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  },
  miniapp_payment_plans: {
    label: '充值套餐',
    description: '星尘商店展示并用于下单校验的正式套餐，以及用户端可见的支付通道和默认通道。',
    defaultValue: [],
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
  system_instructions: {
    label: '主体模板',
    description:
      '自研引擎每轮注入的平台规则（markdown）。须含三个规则槽位、{{WORD_COUNT}} / {{USER_CUSTOM_INSTRUCTIONS}}；编辑与回滚均发布为新快照。',
    defaultValue: DEFAULT_SYSTEM_INSTRUCTIONS,
  },
  [CREATOR_REVIEW_PROMPT_KEY]: {
    label: '角色卡审核',
    description:
      '维护公开角色卡的审核标准正文。公开和公开更新使用已发布版本，未发布草稿不影响当前审核。输出结构由系统固定。',
    defaultValue: DEFAULT_CREATOR_REVIEW_PROMPT,
  },
  choice_rules: {
    label: '选项规则',
    description:
      '选项槽位的完整、简洁和关闭文案；机器标签格式由系统固定协议统一注入，三种模式可独立发布与回滚。',
    defaultValue: {
      on_first_two_turns:
        '本轮需要输出选项。提供三条具体且有区分度的下一步输入建议，不替用户决定行动，也不预演选择结果；严格遵守系统固定富文本协议。',
      on_later_turns:
        '本轮需要输出选项。简洁提供三条下一步输入建议，不替用户作决定；严格遵守系统固定富文本协议。',
      off: '本轮不输出选项，不得输出 [choice]、[/choice]、选项标题或占位内容。',
    },
  },
  memory_rules: {
    label: '记忆区规则',
    description:
      '记忆区槽位的完整、简洁和关闭文案；机器标签格式由系统固定协议统一注入，三种模式可独立发布与回滚。',
    defaultValue: {
      on_first_two_turns:
        '本轮需要输出记忆区。完整更新工作记忆、历史档案和里程碑中的已发生事实，保持时间线连续，既有事实不得擅自改写；严格遵守系统固定富文本协议。',
      on_later_turns:
        '本轮需要输出记忆区。简洁更新工作记忆、历史档案和里程碑中的已发生事实；严格遵守系统固定富文本协议。',
      off: '本轮不输出记忆区，不得输出 [memory]、[/memory]、记忆标题或占位内容。',
    },
  },
  reply_style_options: {
    label: '回复风格',
    description:
      '管理回复偏好中的选项名称、说明、展示顺序与独立开关；沿用草稿、发布和回滚。英文占位符写进主体模板；用户开启的选项，规则内容替换对应占位符，未开启时替换为空。',
    defaultValue: { options: [] },
  },
  [DRIVE_MODE_OPTIONS_KEY]: {
    label: '剧情模式',
    description:
      '回复偏好最上方的「剧情模式」：用户选择剧情由谁推动。每档的名称和说明展示给用户；规则替换主体模板里的 {{DRIVE_RULES}}，模型每次只看到用户所选的一档，所以每档规则必须自成一体。未选择的用户使用默认档。',
    defaultValue: DEFAULT_DRIVE_MODES_CONFIG,
  },
  [FREE_ZONE_CONFIG_KEY]: {
    label: '畅聊（免费模型）',
    description:
      '对话页引擎面板最上方的「畅聊」栏目：总开关、福利期、使用范围、规则文字，以及候选池和自动上下架门槛。总开关只决定用户能不能看到；只要配了候选，后台每 30 分钟都会评估。门槛留空（null）表示这一项不检查。',
    defaultValue: DEFAULT_FREE_ZONE_CONFIG,
  },
  [STORY_MEMORY_CONFIG_KEY]: {
    label: '长期剧情记忆参数',
    description:
      '按正文字数（不含选项/状态栏，去掉空白）截断历史：超过高水位时退到低水位以下，最近「保底轮数」永不截断（至少 11，保证用户可编辑的最近 10 轮不会被压缩）。被截断的章节由后台模型压缩成前情档案并注入后续生成。超过高水位时先在后台压缩、记忆落地后再截断，窗口与记忆同一轮切换；压缩迟迟不成功时超过「高水位 + 高低水位落差的一半」才强制截断。关闭开关时停止生成与注入，直接截断。压缩模型与供应商顺序独立于聊天兜底配置。',
    defaultValue: DEFAULT_STORY_MEMORY_CONFIG,
  },
  [STORY_MEMORY_PROMPT_KEY]: {
    label: '长期剧情记忆 prompt',
    description:
      '后台压缩前情档案时使用的完整 prompt。必须包含 {{old_memory}}、{{new_history}}、{{recent_context}}、{{max_chars}}；可用 {{user_name}}、{{char_name}}。角色卡与开场白始终在聊天 prompt 最前面，不送进压缩。以「## 」开头的行是输出板块标题，系统据此校验输出是否齐全，说明性标题不要用「## 」。',
    defaultValue: DEFAULT_STORY_MEMORY_PROMPT,
  },
  pref_word_count_tiers: {
    label: '回复长度档位',
    description:
      '生成偏好「回复长度」的档位表：可增删档位、改按钮文案与列布局；prompt_value 注入 {{WORD_COUNT}}。',
    defaultValue: DEFAULT_WORD_COUNT_TIERS_CONFIG,
  },
  lobby_ranking_params: {
    label: '推荐轮换与质量评分',
    description:
      '推荐页为全体用户轮换前 12 张优质角色，可设置换批间隔、重复上限和探索数量。轮换参数发布后生效，质量参数在下一次每日评分刷新后生效。',
    defaultValue: DEFAULT_LOBBY_RANKING_PARAMS,
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
  image_plaza_model_catalog: {
    label: '模型管理',
    description: '管理图片广场模型、能力、画幅和各分辨率上架星尘价；用户端只读取已发布版本。',
    defaultValue: {
      default_model_id: 'seedream-v5-pro',
      pricing_factors: { ...DEFAULT_IMAGE_PLAZA_PRICING_FACTORS },
      models: [
        ['qwen-image-3', 'Qwen Image 3', 60],
        ['qwen-image-3-pro', 'Qwen Image 3 Pro', 80],
        ['seedream-v5-pro', 'Seedream V5 Pro', 90],
        ['krea-2-turbo', 'Krea 2 Turbo', 60],
        ['lustify-v8', 'Lustify v8', 20],
        ['seedream-v5-lite', 'Seedream V5 Lite', 80],
        ['chroma', 'Chroma', 20],
        ['lustify-sdxl', 'Lustify SDXL', 20],
        ['anime-wai', 'Anime (WAI)', 20],
        ['venice-sd35', 'Venice SD35', 20],
      ].map(([id, name, credits], sortOrder) => ({
        id,
        provider_model_id: id === 'anime-wai' ? 'wai-Illustrious' : id,
        edit_provider_model_id:
          {
            'qwen-image-3': 'qwen-image-3-edit',
            'qwen-image-3-pro': 'qwen-image-3-pro-edit',
            'seedream-v5-pro': 'seedream-v5-pro-edit',
            'seedream-v5-lite': 'seedream-v5-lite-edit',
          }[String(id)] ?? null,
        sizing_mode: [
          'qwen-image-3',
          'qwen-image-3-pro',
          'seedream-v5-pro',
          'krea-2-turbo',
        ].includes(String(id))
          ? 'resolution'
          : id === 'seedream-v5-lite'
            ? 'aspect_ratio'
            : 'pixels',
        name,
        description: '适合多种图片创作场景',
        supports_i2i: [
          'qwen-image-3',
          'qwen-image-3-pro',
          'seedream-v5-pro',
          'seedream-v5-lite',
        ].includes(String(id)),
        supports_edit: [
          'qwen-image-3',
          'qwen-image-3-pro',
          'seedream-v5-pro',
          'seedream-v5-lite',
        ].includes(String(id)),
        aspect_ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'],
        resolutions: [
          {
            id: [
              'lustify-v8',
              'seedream-v5-lite',
              'chroma',
              'lustify-sdxl',
              'anime-wai',
              'venice-sd35',
            ].includes(String(id))
              ? 'fixed'
              : '1K',
            label: '标准',
            credits,
          },
        ],
        enabled: true,
        sort_order: sortOrder,
        internal_tags: [],
      })),
    },
  },
  image_plaza_video_model_catalog: {
    label: '视频模型管理',
    description:
      '管理视频模型能力、Provider ID 与时长×清晰度×声音价格矩阵；发布前必须用真实参考价替换占位价格。',
    defaultValue: createDefaultVideoCatalog(),
  },
  image_plaza_share_tip: {
    label: '弹窗配置',
    description:
      '配置首次分享确认弹窗的中部文案与开关；顶图始终使用用户作品。仅支持 {rate} 与 {model}。',
    defaultValue: {
      enabled: true,
      title: '分享返还 {rate}',
      description: '让更多人看到你的 {model} 作品。',
      reference_note: '如使用参考图，参考图也会同时公开。',
      button_label: '分享至广场',
    },
  },
  image_plaza_tags: {
    label: '内容标签',
    description:
      '管理图片/视频共用的广场筛选标签与分组；“全部”为系统固定项，删除标签不会删除历史作品。',
    defaultValue: [
      {
        id: 'portrait',
        label: '人像',
        enabled: true,
        sort_order: 0,
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'anime',
        label: '动漫',
        enabled: true,
        sort_order: 1,
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'poster',
        label: '海报',
        enabled: true,
        sort_order: 2,
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
    ],
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
    label: '月卡商品',
    description: '价格使用整数分。发布后只影响新创建的订单。',
    defaultValue: DEFAULT_VIP_PLANS_CONFIG,
  },
  vip_text_discount_rate: {
    label: 'VIP 生成折扣率',
    description:
      '适用于文本、语音和图片付费生成。大于 0 且不超过 1；受理时固化，不重算已受理请求。',
    defaultValue: DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  },
  vip_checkin_bonus_config: {
    label: 'VIP 每日签到星尘',
    description: '有效 VIP 每日签到的专项与通用星尘绝对额（非加成）。兼容旧数字配置（全部专项）。',
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
