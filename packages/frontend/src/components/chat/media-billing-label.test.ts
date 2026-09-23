import { describe, expect, it } from 'vitest';
import { formatFreeTrialBillingLabel } from './media-billing-label';

describe('formatFreeTrialBillingLabel', () => {
  it('shows the published limit instead of a fixed count', () => {
    expect(formatFreeTrialBillingLabel(2, 4)).toBe('免费体验 第 2/4 次 · 本次不消耗星尘');
    expect(formatFreeTrialBillingLabel(1, 20)).toBe('免费体验 第 1/20 次 · 本次不消耗星尘');
    expect(formatFreeTrialBillingLabel(1, 0)).toBe('免费体验 第 1/0 次 · 本次不消耗星尘');
  });

  it('does not invent 3 when the published limit is missing', () => {
    expect(formatFreeTrialBillingLabel(1, null)).toBe('免费体验 · 本次不消耗星尘');
    expect(formatFreeTrialBillingLabel(null, undefined)).toBe('免费体验 · 本次不消耗星尘');
  });
});
