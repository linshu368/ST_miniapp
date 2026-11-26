import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREE_ZONE_CONFIG,
  FreeZoneConfigSchema,
  freeZoneDiscountFloor,
  formatVipWeeklyWindow,
} from './free-zone.js';

const screening = { ...DEFAULT_FREE_ZONE_CONFIG.screening, min_discount_pct: 90 };

describe('per-model discount floor', () => {
  it('uses the candidate’s own floor when set, the shared one otherwise', () => {
    expect(freeZoneDiscountFloor(screening, { min_discount_pct: 86 })).toBe(86);
    expect(freeZoneDiscountFloor(screening, { min_discount_pct: null })).toBe(90);
    expect(freeZoneDiscountFloor(screening, {})).toBe(90);
    expect(freeZoneDiscountFloor(screening, null)).toBe(90);
  });

  it('reads a stored config that still carries the removed screening and delisting keys', () => {
    const config = FreeZoneConfigSchema.parse({
      enabled: true,
      screening: {
        min_discount_pct: 90,
        blocked_providers: ['dashscope-cn'],
        min_samples: 200,
        probe_enabled: true,
      },
      on_shelf: { max_interrupted_pct: 100, max_unusable_pct: 100, max_unroutable_pct: 100 },
      relist: { price_cooldown_minutes: 60, quality_cooldown_minutes: 10000 },
    });
    expect(config.screening).toEqual({ min_discount_pct: 90, blocked_providers: ['dashscope-cn'] });
    expect(config).not.toHaveProperty('on_shelf');
    expect(config).not.toHaveProperty('relist');
  });

  it('defaults older candidates without the field to the shared floor', () => {
    const config = FreeZoneConfigSchema.parse({
      candidates: [
        {
          id: 'free-deepseek-v4-pro',
          surplus_model: 'deepseek-v4-pro',
          display_name: 'DeepSeek V4 Pro',
          family: 'deepseek',
          benchmark_tier: 'premium',
        },
      ],
    });
    expect(config.candidates[0]?.min_discount_pct).toBeNull();
  });
});

describe('formatVipWeeklyWindow', () => {
  it('writes the VIP day in plain words', () => {
    expect(formatVipWeeklyWindow({ weekday: 4, start_minute: 720, duration_minutes: 900 })).toBe(
      '周四 12:00 至次日 03:00'
    );
    expect(formatVipWeeklyWindow({ weekday: 4, start_minute: 720, duration_minutes: 600 })).toBe(
      '周四 12:00 至 22:00'
    );
    expect(formatVipWeeklyWindow({ weekday: 7, start_minute: 1200, duration_minutes: 1800 })).toBe(
      '周日 20:00 至周二 02:00'
    );
  });

  it('defaults access to off so old configs keep the welfare-only behaviour', () => {
    const parsed = FreeZoneConfigSchema.parse({});
    expect(parsed.access).toMatchObject({ enabled: false, trial_since: null, trial_hours: 72 });
    expect(parsed.access.vip_weekly).toEqual({
      weekday: 4,
      start_minute: 720,
      duration_minutes: 900,
    });
    expect(parsed.access.prompt).toEqual({
      min_interval_days: 3,
      batch_size: 3,
      batch_cooldown_days: 30,
    });
  });
});

describe('free-zone fallback channel', () => {
  it('stays off for stored configs that predate it', () => {
    expect(FreeZoneConfigSchema.parse({}).fallback).toBeNull();
  });

  it('defaults to Surplus 1017, mistral first, speed first and a wide price band', () => {
    expect(FreeZoneConfigSchema.parse({ fallback: {} }).fallback).toEqual({
      surplus_model: 'deepseek-v4.1-flash-1017',
      preferred_provider: 'mistral',
      route_objective: 'latency',
      price_tolerance_pct: 1000,
    });
  });

  it('lets the preferred provider be cleared and rejects unknown objectives', () => {
    expect(
      FreeZoneConfigSchema.parse({ fallback: { preferred_provider: null } }).fallback
        ?.preferred_provider
    ).toBeNull();
    expect(() => FreeZoneConfigSchema.parse({ fallback: { route_objective: 'price' } })).toThrow();
  });
});
