import { getDomainDb } from '../../../lib/supabase.js';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  PaymentPlansSchema,
  PaymentPromptDialogConfigSchema,
  RechargePageConfigSchema,
  type PaymentPlan,
  type PaymentPromptDialogConfig,
  type RechargePageConfig,
} from '@miniapp/shared';

export const PAYMENT_PLANS_CONFIG_KEY = 'miniapp_payment_plans';
export const RECHARGE_PAGE_CONFIG_KEY = 'miniapp_recharge_page_config';
export const PAYMENT_PROMPT_DIALOG_CONFIG_KEY = 'miniapp_payment_prompt_dialog_config';
export const INSUFFICIENT_CREDITS_NOTICE_CONFIG_KEY = 'insufficient_credits_notice';
export const ORDER_EXPIRE_MS = 15 * 60 * 1000;

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
