import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PENDING_ARRIVAL_HINT,
  PaymentPlansSchema,
  PaymentPromptDialogConfigSchema,
  RechargePageConfigSchema,
} from '../api/payment.js';

const plan = {
  id: 'plan-entry',
  price_cents: 600,
  original_price_cents: null,
  credits_amount: 600,
  bonus_credits: 0,
  variant: 'entry',
  badge_text: null,
  sub_copy: '初次邂逅',
  highlight_text: null,
};

describe('PaymentPlansSchema', () => {
  it('accepts a nonempty unique plan catalog', () => {
    expect(PaymentPlansSchema.parse([plan])).toEqual([plan]);
  });

  it('rejects missing plans and duplicate stable ids', () => {
    expect(PaymentPlansSchema.safeParse(undefined).success).toBe(false);
    expect(PaymentPlansSchema.safeParse([]).success).toBe(false);
    expect(PaymentPlansSchema.safeParse([plan, plan]).success).toBe(false);
  });
});

describe('RechargePageConfigSchema', () => {
  it('accepts real page copy and a six-digit theme color', () => {
    expect(
      RechargePageConfigSchema.parse({
        title: '星尘商店',
        description: '为每段相遇点一盏星光',
        button_text: '立即支付',
        theme_color: '#ec4899',
        balance_color: '#8b5cf6',
        selected_plan_color: '#f59e0b',
        badge_color: '#6366f1',
        button_color: '#ec4899',
      })
    ).toMatchObject({ theme_color: '#ec4899' });
  });

  it('fills independent component colors and pending hint for legacy page configurations', () => {
    expect(
      RechargePageConfigSchema.parse({
        title: '星尘商店',
        description: '说明',
        button_text: '支付',
        theme_color: '#112233',
      })
    ).toMatchObject({
      balance_color: '#8b5cf6',
      selected_plan_color: '#f59e0b',
      badge_color: '#6366f1',
      button_color: '#ec4899',
      pending_arrival_hint: DEFAULT_PENDING_ARRIVAL_HINT,
    });
  });

  it('rejects color names and empty copy', () => {
    expect(
      RechargePageConfigSchema.safeParse({
        title: '',
        description: '说明',
        button_text: '支付',
        theme_color: 'pink',
      }).success
    ).toBe(false);
    expect(
      RechargePageConfigSchema.safeParse({
        title: '星尘商店',
        description: '说明',
        button_text: '支付',
        theme_color: '#112233',
        pending_arrival_hint: '',
      }).success
    ).toBe(false);
  });
});

describe('PaymentPromptDialogConfigSchema', () => {
  const config = {
    enabled: true,
    title: '支付前请先关闭 VPN',
    description: '请关闭 VPN 后再继续支付。',
    confirm_text: '已关闭VPN，继续支付',
    footer_note: '确认后打开外部浏览器。',
    accent_color: '#f59e0b',
  };

  it('accepts the payment confirmation copy and accent color', () => {
    expect(PaymentPromptDialogConfigSchema.parse(config)).toEqual(config);
  });

  it('fills the footer note for legacy dialog configurations', () => {
    const { footer_note } = PaymentPromptDialogConfigSchema.parse({
      enabled: true,
      title: '支付前请先关闭 VPN',
      description: '请关闭 VPN 后再继续支付。',
      confirm_text: '已关闭VPN，继续支付',
      accent_color: '#f59e0b',
    });

    expect(footer_note).toBe('点击确认后，将继续跳转到外部浏览器完成微信支付。');
  });

  it('rejects empty copy and invalid colors', () => {
    expect(
      PaymentPromptDialogConfigSchema.safeParse({
        ...config,
        description: '',
        accent_color: 'yellow',
      }).success
    ).toBe(false);
  });
});
