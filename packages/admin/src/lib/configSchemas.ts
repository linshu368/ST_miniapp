import {
  DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  DEFAULT_LOBBY_PINNED_CHARACTERS,
  DEFAULT_LOBBY_RANKING_PARAMS,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  FreeQuotaExhaustedDialogConfigSchema,
  LlmPricingConfigSchema,
  LobbyPinnedCharactersSchema,
  LobbyRankingParamsSchema,
  ModelCatalogSchema,
  normalizeCatalogModelInput,
  PaymentPlansSchema,
  RechargePageConfigSchema,
  WordCountTiersConfigSchema,
} from '@miniapp/shared';
import { z } from 'zod';

export const managedConfigKeys = [
  'miniapp_new_user_signup_bonus_credits',
  'miniapp_daily_checkin_bonus_credits',
  'miniapp_character_free_chat_quota_limit',
  'miniapp_payment_plans',
  'miniapp_recharge_page_config',
  'miniapp_free_quota_exhausted_dialog_config',
  'llm_model_catalog',
  'llm_pricing_config',
  'system_fallback_character_id',
  'system_instructions',
  'pref_word_count_tiers',
  'lobby_ranking_params',
  'lobby_pinned_characters',
] as const;

export type ManagedConfigKey = (typeof managedConfigKeys)[number];

/** 存 runtime_config.text_value 的 managed key；草稿 value 为 null */
export const TEXT_MANAGED_CONFIG_KEYS = ['system_instructions'] as const;
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
  miniapp_free_quota_exhausted_dialog_config: FreeQuotaExhaustedDialogConfigSchema,
  llm_model_catalog: ModelCatalogSchema,
  llm_pricing_config: LlmPricingConfigSchema,
  system_fallback_character_id: z.string().uuid(),
  system_instructions: SystemInstructionsSchema,
  pref_word_count_tiers: WordCountTiersConfigSchema,
  lobby_ranking_params: LobbyRankingParamsSchema,
  lobby_pinned_characters: LobbyPinnedCharactersSchema,
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
    description: '用户每次满足签到间隔后获得的 bonus 星尘。',
    defaultValue: 40,
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
    description: '星尘商店的标题、说明、支付按钮文字和主题色。',
    defaultValue: DEFAULT_RECHARGE_PAGE_CONFIG,
  },
  miniapp_free_quota_exhausted_dialog_config: {
    label: '免费额度耗尽弹窗',
    description:
      '角色卡免费额度耗尽后自动展示的标题和说明文案；轮次数请与「角色卡免费对话轮次」保持一致。',
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
