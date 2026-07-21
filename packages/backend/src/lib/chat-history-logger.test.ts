import { describe, expect, it } from 'vitest';
import { calculateUsageDeduction } from '../features/billing/usage-pricing.js';

describe('calculateUsageDeduction', () => {
  it('uses the selected model markup exactly once', () => {
    expect(calculateUsageDeduction(0.01, 680, 2.5)).toBe(17);
    expect(calculateUsageDeduction(0.01, 680, 4)).toBe(27);
  });

  it('rejects invalid costs and markups', () => {
    expect(() => calculateUsageDeduction(-1, 680, 2.5)).toThrow();
    expect(() => calculateUsageDeduction(0.01, 680, 0)).toThrow();
  });
});
