import {
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  FreeQuotaExhaustedDialogConfigSchema,
  ModelCatalogSchema,
  PaymentPlansSchema,
  RechargePageConfigSchema,
} from '@miniapp/shared';
import { z } from 'zod';

export const managedConfigKeys = [
  'miniapp_new_user_signup_bonus_credits',
  'miniapp_daily_checkin_bonus_credits',
  'miniapp_payment_plans',
  'miniapp_recharge_page_config',
  'miniapp_free_quota_exhausted_dialog_config',
  'llm_model_catalog',
  'llm_pricing_config',
  'system_fallback_character_id',
] as const;

export type ManagedConfigKey = (typeof managedConfigKeys)[number];

const nonnegativeInteger = z.number().int().nonnegative();
export const LlmPricingConfigSchema = z.object({
  balanceBaseline: z.number().nonnegative(),
  fallbackCost: z.number().nonnegative(),
  exchangeRate: z.number().positive(),
  markup: z.number().positive(),
});

const EditableModelCatalogModelSchema = z.object({
  id: z.string(),
  openrouter_model_id: z.string(),
  display_name: z.string(),
  tagline: z.string(),
  price_input: z.number().finite().nonnegative(),
  price_output: z.number().finite().nonnegative(),
  markup: z.number().finite(),
  deduct_markup: z.number().finite().optional(),
  enabled: z.boolean(),
  sort_order: z.number().int().nonnegative(),
});

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

export const configSchemas: Record<ManagedConfigKey, z.ZodTypeAny> = {
  miniapp_new_user_signup_bonus_credits: nonnegativeInteger,
  miniapp_daily_checkin_bonus_credits: nonnegativeInteger,
  miniapp_payment_plans: PaymentPlansSchema,
  miniapp_recharge_page_config: RechargePageConfigSchema,
  miniapp_free_quota_exhausted_dialog_config: FreeQuotaExhaustedDialogConfigSchema,
  llm_model_catalog: ModelCatalogSchema,
  llm_pricing_config: LlmPricingConfigSchema,
  system_fallback_character_id: z.string().uuid(),
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
    description: '角色卡 50 轮免费额度耗尽后自动展示 3 秒的标题和说明文案。',
    defaultValue: DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  },
  llm_model_catalog: {
    label: '模型目录',
    description: '用户可选择的 OpenRouter 模型、档位、展示价与默认模型。',
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
              price_input: 0,
              price_output: 0,
              markup: 2.5,
              enabled: true,
              sort_order: 1,
            },
          ],
        },
      ],
    },
  },
  llm_pricing_config: {
    label: '动态计费参数',
    description: '实际扣费基础参数；markup 仅供旧目录兼容，新目录使用每个模型自己的倍率。',
    defaultValue: {
      balanceBaseline: 30,
      fallbackCost: 30,
      exchangeRate: 680,
      markup: 2.5,
    },
  },
  system_fallback_character_id: {
    label: '系统兜底角色',
    description: '角色不可用时使用的系统兜底角色 UUID。',
    defaultValue: '',
  },
};

export function parseManagedConfig(key: ManagedConfigKey, value: unknown): unknown {
  return configSchemas[key].parse(value);
}
