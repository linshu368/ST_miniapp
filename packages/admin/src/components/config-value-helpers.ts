import {
  DEFAULT_PAYMENT_CHANNELS_CONFIG,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  type PaymentPlan,
  type PaymentPlansConfig,
  type WordCountTiersConfig,
} from '@miniapp/shared';
import {
  DEFAULT_INVITE_CENTER_CONFIG,
  DEFAULT_INVITE_REWARD_RULES,
  type InviteCenterConfig,
  type InviteRewardRulesConfig,
} from '@miniapp/admin-client';

export function asWordCountTiersConfig(value: unknown): WordCountTiersConfig {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as WordCountTiersConfig).tiers)
  ) {
    const record = value as WordCountTiersConfig;
    return {
      tiers: record.tiers,
      default_tier_id: record.default_tier_id || DEFAULT_WORD_COUNT_TIERS_CONFIG.default_tier_id,
      layout: {
        columns:
          record.layout?.columns === 2 ||
          record.layout?.columns === 3 ||
          record.layout?.columns === 4
            ? record.layout.columns
            : 4,
      },
    };
  }
  return structuredClone(DEFAULT_WORD_COUNT_TIERS_CONFIG);
}

/**
 * 宽松结构归一化（对齐 asWordCountTiersConfig 的做法）：
 * 只校验形状不校验取值，编辑中间态（清空文案、清空数字）不会把整个表单打回默认值；
 * 取值合法性由保存时的 zod + DB 校验兜底。
 */
export function asInviteRewardRules(value: unknown): InviteRewardRulesConfig {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as InviteRewardRulesConfig).rules)
  ) {
    const record = value as InviteRewardRulesConfig;
    return {
      total_cap_credits:
        typeof record.total_cap_credits === 'number'
          ? record.total_cap_credits
          : DEFAULT_INVITE_REWARD_RULES.total_cap_credits,
      rules: record.rules.map((rule) => ({
        rule_key: typeof rule?.rule_key === 'string' ? rule.rule_key : '',
        credits: typeof rule?.credits === 'number' ? rule.credits : 1,
        enabled: rule?.enabled === true,
        ...(typeof rule?.threshold_rounds === 'number'
          ? { threshold_rounds: rule.threshold_rounds }
          : {}),
      })),
    };
  }
  return structuredClone(DEFAULT_INVITE_REWARD_RULES);
}

export function asInviteCenterConfig(value: unknown): InviteCenterConfig {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as InviteCenterConfig).copy_templates)
  ) {
    const record = value as InviteCenterConfig;
    return {
      poster_url: typeof record.poster_url === 'string' ? record.poster_url : '',
      copy_templates: record.copy_templates.map((template) =>
        typeof template === 'string' ? template : ''
      ),
    };
  }
  return structuredClone(DEFAULT_INVITE_CENTER_CONFIG);
}

export function asPaymentPlansConfig(value: unknown): PaymentPlansConfig {
  if (Array.isArray(value)) {
    return { plans: value as PaymentPlan[], payment_channels: DEFAULT_PAYMENT_CHANNELS_CONFIG };
  }
  if (value && typeof value === 'object' && Array.isArray((value as PaymentPlansConfig).plans)) {
    const record = value as Partial<PaymentPlansConfig>;
    return {
      plans: record.plans ?? [],
      payment_channels: {
        alipay_enabled: record.payment_channels?.alipay_enabled === true,
        wxpay_enabled: record.payment_channels?.wxpay_enabled === true,
        default_payment_type:
          record.payment_channels?.default_payment_type === 'wxpay' ? 'wxpay' : 'alipay',
      },
    };
  }
  return { plans: [], payment_channels: DEFAULT_PAYMENT_CHANNELS_CONFIG };
}
