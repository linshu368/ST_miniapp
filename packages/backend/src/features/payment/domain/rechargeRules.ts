import { getSupabaseClient } from '../../../lib/supabase.js';
import type { PaymentPlan } from '@miniapp/shared';

export const PAYMENT_PLANS_CONFIG_KEY = 'miniapp_payment_plans';
export const ORDER_EXPIRE_MS = 15 * 60 * 1000;

const DEFAULT_PAYMENT_PLANS: PaymentPlan[] = [
  {
    id: 'plan-entry-6',
    price_cents: 600,
    original_price_cents: null,
    credits_amount: 600,
    bonus_credits: 0,
    variant: 'entry',
    badge_text: null,
    sub_copy: '初次邂逅',
    highlight_text: null,
  },
  {
    id: 'plan-standard-28',
    price_cents: 2800,
    original_price_cents: 3300,
    credits_amount: 3000,
    bonus_credits: 0,
    variant: 'standard',
    badge_text: '入门首选',
    sub_copy: '沉浸式体验',
    highlight_text: null,
  },
  {
    id: 'plan-recommended-98',
    price_cents: 9800,
    original_price_cents: 11800,
    credits_amount: 9800,
    bonus_credits: 2000,
    variant: 'recommended',
    badge_text: '75% 用户的选择',
    sub_copy: '立省¥20 · 低至 0.04元/次调用',
    highlight_text: '🔥 免费送 2,000',
  },
  {
    id: 'plan-premium-328',
    price_cents: 32800,
    original_price_cents: 42800,
    credits_amount: 32800,
    bonus_credits: 10000,
    variant: 'premium',
    badge_text: '大户专享',
    sub_copy: '≈ 3600次旗舰模型 · 历史最低单价',
    highlight_text: '狂送 10,000',
  },
];

export async function getPaymentPlans(): Promise<PaymentPlan[]> {
  const db = getSupabaseClient().schema('miniapp');
  const { data, error } = await db
    .from('runtime_config')
    .select('value')
    .eq('key', PAYMENT_PLANS_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`[payment] 读取套餐配置失败，使用默认套餐：${error.message}`);
    return DEFAULT_PAYMENT_PLANS;
  }

  return isPaymentPlans(data?.value) ? data.value : DEFAULT_PAYMENT_PLANS;
}

export async function findPaymentPlan(planId: string): Promise<PaymentPlan | undefined> {
  const plans = await getPaymentPlans();
  return plans.find((plan) => plan.id === planId);
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

function isPaymentPlans(value: unknown): value is PaymentPlan[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      typeof (item as PaymentPlan).id === 'string' &&
      typeof (item as PaymentPlan).price_cents === 'number' &&
      typeof (item as PaymentPlan).credits_amount === 'number' &&
      typeof (item as PaymentPlan).bonus_credits === 'number'
  );
}
