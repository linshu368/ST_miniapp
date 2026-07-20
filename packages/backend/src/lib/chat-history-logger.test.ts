import { describe, expect, it } from 'vitest';
import {
  calculateFallbackDeduction,
  calculateUsageDeduction,
} from '../features/billing/usage-pricing.js';

describe('calculateUsageDeduction', () => {
  it('uses the selected model markup exactly once', () => {
    expect(calculateUsageDeduction(0.01, 680, 2.5)).toBe(17);
    expect(calculateUsageDeduction(0.01, 680, 4)).toBe(27.2);
  });

  it('rounds actual charges to one decimal place', () => {
    expect(calculateUsageDeduction(0.001, 100, 1)).toBe(0.1);
  });

  it('keeps free usage and fallback charges at zero', () => {
    expect(calculateUsageDeduction(10, 680, 0)).toBe(0);
    expect(calculateFallbackDeduction(30, 0)).toBe(0);
  });

  it('restores charging when markup becomes nonzero', () => {
    expect(calculateFallbackDeduction(30, 1)).toBe(30);
    expect(calculateUsageDeduction(0.01, 680, 1)).toBe(6.8);
  });

  it('rejects invalid costs and negative markups', () => {
    expect(() => calculateUsageDeduction(-1, 680, 2.5)).toThrow();
    expect(() => calculateUsageDeduction(0.01, 680, -1)).toThrow();
  });
});
