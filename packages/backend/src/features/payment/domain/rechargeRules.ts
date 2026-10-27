import {
  fetchRuntimeConfigEntries,
  fetchRuntimeConfigEntry,
} from '../../../platform/runtime-config.js';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  isVipPlanId,
  PaymentPlansRuntimeConfigSchema,
  PaymentPromptDialogConfigSchema,
  RechargePageConfigSchema,
  type PaymentPlan,
  type PaymentChannelsConfig,
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
/** 星尘套餐沿用 Production 当前网关商品名，避免发布时改变渠道受理语义。 */
export const CREDITS_GATEWAY_PRODUCT_NAME = '星尘';

const DEFAULT_INSUFFICIENT_CREDITS_NOTICE = '当前星尘积分不足，需要先购买积分才能继续聊天。';

export class PaymentPlansConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentPlansConfigError';
  }
}

export interface PaymentPageRuntimeConfig {
  plans: PaymentPlan[];
  paymentChannels: PaymentChannelsConfig;
  pageConfig: RechargePageConfig;
  paymentPromptDialogConfig: PaymentPromptDialogConfig;
  insufficientCreditsNotice: string;
}

const PAYMENT_PAGE_CONFIG_KEYS = [
  PAYMENT_PLANS_CONFIG_KEY,
  RECHARGE_PAGE_CONFIG_KEY,
  PAYMENT_PROMPT_DIALOG_CONFIG_KEY,
  INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY,
] as const;

/** 页面展示所需配置同表批量读取；订单创建仍单独读取权威套餐。 */
export async function getPaymentPageRuntimeConfig(): Promise<PaymentPageRuntimeConfig> {
  const entries = await fetchRuntimeConfigEntries(PAYMENT_PAGE_CONFIG_KEYS);
  const payment = parsePaymentPlansRuntimeConfig(entries.get(PAYMENT_PLANS_CONFIG_KEY)?.value);
  return {
    plans: payment.plans,
    paymentChannels: payment.payment_channels,
    pageConfig: parseRechargePageConfig(entries.get(RECHARGE_PAGE_CONFIG_KEY)?.value),
    paymentPromptDialogConfig: parsePaymentPromptDialogConfig(
      entries.get(PAYMENT_PROMPT_DIALOG_CONFIG_KEY)?.value
    ),
    insufficientCreditsNotice: parseInsufficientCreditsNotice(
      entries.get(INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY)
    ),
  };
}

export async function getPaymentPlans(): Promise<PaymentPlan[]> {
  return (await getPaymentPlansConfig()).plans;
}

export async function getPaymentPlansConfig(): Promise<{
  plans: PaymentPlan[];
  paymentChannels: PaymentChannelsConfig;
}> {
  const entry = await fetchRuntimeConfigEntry(PAYMENT_PLANS_CONFIG_KEY);
  const config = parsePaymentPlansRuntimeConfig(entry?.value);
  return { plans: config.plans, paymentChannels: config.payment_channels };
}

export function parsePaymentPlansConfig(value: unknown): PaymentPlan[] {
  return parsePaymentPlansRuntimeConfig(value).plans;
}

export function parsePaymentPlansRuntimeConfig(value: unknown) {
  const parsed = PaymentPlansRuntimeConfigSchema.safeParse(value);
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
  const entry = await fetchRuntimeConfigEntry(RECHARGE_PAGE_CONFIG_KEY);
  return parseRechargePageConfig(entry?.value);
}

function parseRechargePageConfig(value: unknown): RechargePageConfig {
  const parsed = RechargePageConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RECHARGE_PAGE_CONFIG;
}

export function parsePaymentPromptDialogConfig(value: unknown): PaymentPromptDialogConfig {
  const parsed = PaymentPromptDialogConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
}

export async function getPaymentPromptDialogConfig(): Promise<PaymentPromptDialogConfig> {
  const entry = await fetchRuntimeConfigEntry(PAYMENT_PROMPT_DIALOG_CONFIG_KEY);
  return parsePaymentPromptDialogConfig(entry?.value);
}

export async function getInsufficientCreditsNotice(): Promise<string> {
  const entry = await fetchRuntimeConfigEntry(INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY);
  return parseInsufficientCreditsNotice(entry);
}

function parseInsufficientCreditsNotice(
  entry: { value: unknown; textValue: string | null } | null | undefined
): string {
  const textValue = entry?.textValue?.trim() ?? '';
  if (textValue) return textValue;

  const jsonValue = typeof entry?.value === 'string' ? entry.value.trim() : '';
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
    gateway_product_name: planId === 'week' ? '周卡' : '月卡',
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
