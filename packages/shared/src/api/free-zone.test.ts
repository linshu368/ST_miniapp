import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREE_ZONE_CONFIG,
  FreeZoneConfigSchema,
  freeZoneDiscountFloor,
  freeZoneRulesFor,
} from './free-zone.js';

const screening = { ...DEFAULT_FREE_ZONE_CONFIG.screening, min_discount_pct: 90 };

describe('per-model discount floor', () => {
  it('uses the candidate’s own floor when set, the shared one otherwise', () => {
    expect(freeZoneDiscountFloor(screening, { min_discount_pct: 86 })).toBe(86);
    expect(freeZoneDiscountFloor(screening, { min_discount_pct: null })).toBe(90);
    expect(freeZoneDiscountFloor(screening, {})).toBe(90);
    expect(freeZoneDiscountFloor(screening, null)).toBe(90);
  });

  it('only swaps the floor in the screening rules', () => {
    const rules = freeZoneRulesFor(screening, { min_discount_pct: 86 });
    expect(rules).toEqual({ ...screening, min_discount_pct: 86 });
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
