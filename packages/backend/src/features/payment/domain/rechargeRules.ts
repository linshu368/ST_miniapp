import { getDomainDb } from '../../../lib/supabase.js';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  isVipPlanId,
  PaymentPlansSchema,
  PaymentPromptDialogConfigSchema,
  RechargePageConfigSchema,
  type PaymentPlan,
  type PaymentProductType,
  type PaymentPromptDialogConfig,
  type RechargePageConfig,
  type VipPlan,
  type VipPlanId,
  type VipPlansConfig,
} from '@miniapp/shared';
import { readVipStrategy } from '../../../platform/vip-strategy.js';

export const PAYMENT_PLANS_CONFIG_KEY = 'miniapp_payment_plans';
export const RECHARGE_PAGE_CONFIG_KEY = 'miniapp_recharge_page_config';
export const PAYMENT_PROMPT_DIALOG_CONFIG_KEY = 'miniapp_payment_prompt_dialog_config';
export const INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY = 'insufficient_credits_notice';
export const VIP_PURCHASE_ENABLED_CONFIG_KEY = 'vip_purchase_enabled';
export const ORDER_EXPIRE_MS = 15 * 60 * 1000;
/** 星尘套餐沿用已验证的网关商品名，避免改回曾触发渠道拦截的文案。 */
export const CREDITS_GATEWAY_PRODUCT_NAME = 'VIP会员';

const DEFAULT_INSUFFICIENT_CREDITS_NOTICE = '当前星尘积分不足，需要先购买积分才能继续聊天。';

export class PaymentPlansConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentPlansConfigError';
  }
}

export async function getPaymentPlans(): Promise<PaymentPlan[]> {
  const db = getDomainDb('app_core');
  const { data, error } = await db
    .from('runtime_config')
    .select('value')
    .eq('key', PAYMENT_PLANS_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    throw new PaymentPlansConfigError(`读取套餐配置失败：${error.message}`);
  }

  return parsePaymentPlansConfig(data?.value);
}

export function parsePaymentPlansConfig(value: unknown): PaymentPlan[] {
  const parsed = PaymentPlansSchema.safeParse(value);
  if (!parsed.success) {
    throw new PaymentPlansConfigError('充值套餐未配置或配置无效，请在运营平台中发布套餐');
  }
  return parsed.data;
}

export async function findPaymentPlan(planId: string): Promise<PaymentPlan | undefined> {
  const plans = await getPaymentPlans();
  return plans.find((plan) => plan.id === planId);
}

export async function getRechargePageConfig(): Promise<RechargePageConfig> {
  const db = getDomainDb('app_core');
  const { data, error } = await db
    .from('runtime_config')
    .select('value')
    .eq('key', RECHARGE_PAGE_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`[payment] 读取充值页面配置失败，使用默认配置：${error.message}`);
    return DEFAULT_RECHARGE_PAGE_CONFIG;
  }
  const parsed = RechargePageConfigSchema.safeParse(data?.value);
  return parsed.success ? parsed.data : DEFAULT_RECHARGE_PAGE_CONFIG;
}

export function parsePaymentPromptDialogConfig(value: unknown): PaymentPromptDialogConfig {
  const parsed = PaymentPromptDialogConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
}

export async function getPaymentPromptDialogConfig(): Promise<PaymentPromptDialogConfig> {
  const db = getDomainDb('app_core');
  const { data, error } = await db
    .from('runtime_config')
    .select('value')
    .eq('key', PAYMENT_PROMPT_DIALOG_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`[payment] 读取支付提示弹窗配置失败，使用默认配置：${error.message}`);
    return DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
  }

  return parsePaymentPromptDialogConfig(data?.value);
}

export async function getInsufficientCreditsNotice(): Promise<string> {
  const db = getDomainDb('app_core');
  const { data, error } = await db
    .from('runtime_config')
    .select('text_value,value')
    .eq('key', INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`[payment] 读取积分不足提示语失败，使用默认文案：${error.message}`);
    return DEFAULT_INSUFFICIENT_CREDITS_NOTICE;
  }

  const textValue = typeof data?.text_value === 'string' ? data.text_value.trim() : '';
  if (textValue) return textValue;

  const jsonValue = typeof data?.value === 'string' ? data.value.trim() : '';
  return jsonValue || DEFAULT_INSUFFICIENT_CREDITS_NOTICE;
}

export class UnknownPaymentPlanError extends Error {
  constructor() {
    super('支付套餐不存在');
    this.name = 'UnknownPaymentPlanError';
  }
}

export class VipPurchaseDisabledError extends Error {
  constructor() {
    super('VIP 购买未开放');
    this.name = 'VipPurchaseDisabledError';
  }
}

export interface PaymentProductSnapshot {
  product_type: PaymentProductType;
  product_id: string;
  amount_cents: number;
  credits_amount: number;
  bonus_credits: number;
  vip_duration_days: number | null;
  vip_bonus_credits: number | null;
  gateway_product_name: string;
}

/** 缺配置、读失败或非 true 都关闭购买。credits 充值不读这个开关。 */
export function parseVipPurchaseEnabled(value: unknown): boolean {
  return value === true;
}

export async function isVipPurchaseEnabled(): Promise<boolean> {
  return (await readVipStrategy()).purchaseEnabled;
}

export function buildVipPlans(
  purchaseEnabled: boolean,
  plans: VipPlansConfig = DEFAULT_VIP_PLANS_CONFIG
): VipPlan[] {
  return (['week', 'month'] as const).map((planId) => {
    const terms = plans[planId];
    return {
      id: planId,
      price_cents: terms.price_cents,
      duration_days: terms.duration_days,
      bonus_credits: terms.bonus_credits,
      title: terms.title,
      description: terms.description,
      badge_text: terms.badge_text,
      available: purchaseEnabled,
    };
  });
}

export function buildCreditsProductSnapshot(plan: PaymentPlan): PaymentProductSnapshot {
  return {
    product_type: 'credits',
    product_id: plan.id,
    amount_cents: plan.price_cents,
    credits_amount: plan.credits_amount,
    bonus_credits: plan.bonus_credits,
    vip_duration_days: null,
    vip_bonus_credits: null,
    gateway_product_name: CREDITS_GATEWAY_PRODUCT_NAME,
  };
}

export function buildVipProductSnapshot(
  planId: VipPlanId,
  plans: VipPlansConfig = DEFAULT_VIP_PLANS_CONFIG
): PaymentProductSnapshot {
  const terms = plans[planId];
  return {
    product_type: 'vip',
    product_id: planId,
    amount_cents: terms.price_cents,
    credits_amount: 0,
    bonus_credits: 0,
    vip_duration_days: terms.duration_days,
    vip_bonus_credits: terms.bonus_credits,
    gateway_product_name: planId === 'week' ? 'VIP周卡' : 'VIP月卡',
  };
}

export async function resolvePaymentProduct(
  planId: string,
  input: {
    vipPurchaseEnabled: boolean;
    plans?: VipPlansConfig;
    findPlan: (planId: string) => Promise<PaymentPlan | undefined>;
  }
): Promise<PaymentProductSnapshot> {
  if (isVipPlanId(planId)) {
    if (!input.vipPurchaseEnabled) {
      throw new VipPurchaseDisabledError();
    }
    return buildVipProductSnapshot(planId, input.plans ?? DEFAULT_VIP_PLANS_CONFIG);
  }

  const plan = await input.findPlan(planId);
  if (!plan) throw new UnknownPaymentPlanError();
  return buildCreditsProductSnapshot(plan);
}

export function generateMiniappOrderId(userId: string): string {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `MA_${userId}_${timestamp}_${random}`;
}

export function formatAmountCny(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}
