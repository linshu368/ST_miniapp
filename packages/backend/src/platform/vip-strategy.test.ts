import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  VIP_TEXT_DISCOUNT_RATE,
} from '@miniapp/shared';
import type { RuntimeConfigEntry } from './runtime-config.js';
import { interpretVipStrategy, readVipStrategy } from './vip-strategy.js';

vi.mock('./runtime-config.js', () => ({
  fetchRuntimeConfigEntries: vi.fn(),
}));

function entry(value: unknown, version = 2): RuntimeConfigEntry {
  return { value, textValue: null, version };
}

describe('interpretVipStrategy', () => {
  it('uses the published values when they are valid', () => {
    const plans = structuredClone(DEFAULT_VIP_PLANS_CONFIG);
    plans.week.price_cents = 1500;
    const strategy = interpretVipStrategy(
      new Map([
        ['vip_purchase_enabled', entry(false, 1)],
        ['vip_reminders_enabled', entry(false, 1)],
        ['vip_plans_config', entry(plans, 8)],
        ['vip_text_discount_rate', entry(0.8, 5)],
        ['vip_checkin_bonus_config', entry({ mode: 'fixed', fixed_credits: 10 }, 6)],
        ['feature_free_trial_limits', entry({ voice: 0, basic_image: 20 }, 7)],
      ])
    );
    expect(strategy.purchaseEnabled).toBe(false);
    expect(strategy.remindersEnabled).toBe(false);
    expect(strategy.plans.week.price_cents).toBe(1500);
    expect(strategy.plansVersion).toBe(8);
    expect(strategy.discountRate).toBe(0.8);
    expect(strategy.discountVersion).toBe(5);
    expect(strategy.checkin).toEqual({ mode: 'fixed', fixed_credits: 10 });
    expect(strategy.limits).toEqual({ voice: 0, basic_image: 20 });
    expect(strategy.fallbacks).toEqual([]);
  });

  it('fails purchase and reminders closed and falls back the other fields', () => {
    const missing = interpretVipStrategy(new Map());
    expect(missing.purchaseEnabled).toBe(false);
    expect(missing.remindersEnabled).toBe(false);
    expect(missing.plans).toEqual(DEFAULT_VIP_PLANS_CONFIG);
    expect(missing.discountRate).toBe(VIP_TEXT_DISCOUNT_RATE);
    expect(missing.checkin).toEqual(DEFAULT_VIP_CHECKIN_BONUS_CONFIG);
    expect(missing.limits).toEqual(DEFAULT_FEATURE_FREE_TRIAL_LIMITS);
    expect(missing.plansVersion).toBeNull();
    expect(missing.fallbacks.map((item) => item.reason)).toEqual([
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
      'missing',
    ]);

    const damaged = interpretVipStrategy(
      new Map([
        ['vip_purchase_enabled', entry('true')],
        ['vip_reminders_enabled', entry(1)],
        ['vip_plans_config', entry({ week: { price_cents: 1 } })],
        ['vip_text_discount_rate', entry(0)],
        ['vip_checkin_bonus_config', entry({ mode: 'fixed' })],
        ['feature_free_trial_limits', entry({ voice: 21, basic_image: 3 })],
      ])
    );
    expect(damaged.purchaseEnabled).toBe(false);
    expect(damaged.remindersEnabled).toBe(false);
    expect(damaged.discountRate).toBe(0.95);
    expect(damaged.limits).toEqual(DEFAULT_FEATURE_FREE_TRIAL_LIMITS);
    expect(damaged.checkin).toEqual({ mode: 'same_as_base' });
    expect(damaged.fallbacks.every((item) => item.reason === 'invalid')).toBe(true);
  });
});

describe('readVipStrategy', () => {
  it('logs a fallback without including the raw config value', async () => {
    const { fetchRuntimeConfigEntries } = await import('./runtime-config.js');
    vi.mocked(fetchRuntimeConfigEntries).mockResolvedValue(new Map());
    const strategy = await readVipStrategy();
    expect(strategy.purchaseEnabled).toBe(false);
    expect(strategy.discountRate).toBe(0.95);
  });
});
