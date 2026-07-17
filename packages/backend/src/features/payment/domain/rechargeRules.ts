import { getSupabaseClient } from '../../../lib/supabase.js';
import { PaymentPlansSchema, type PaymentPlan } from '@miniapp/shared';

export const PAYMENT_PLANS_CONFIG_KEY = 'miniapp_payment_plans';
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
  const db = getSupabaseClient().schema('miniapp');
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

export async function getInsufficientCreditsNotice(): Promise<string> {
  const db = getSupabaseClient().schema('miniapp');
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
