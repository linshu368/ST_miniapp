import { describe, expect, it } from 'vitest';
import { formatFreeTrialBillingLabel } from './media-billing-label';

describe('formatFreeTrialBillingLabel', () => {
  it('shows the published limit instead of a fixed count', () => {
    expect(formatFreeTrialBillingLabel(2, 4)).toBe('免费体验 2/4');
    expect(formatFreeTrialBillingLabel(1, 20)).toBe('免费体验 1/20');
    expect(formatFreeTrialBillingLabel(1, 0)).toBe('免费体验 1/0');
  });

  it('does not invent 3 when the published limit is missing', () => {
    expect(formatFreeTrialBillingLabel(1, null)).toBe('免费体验');
    expect(formatFreeTrialBillingLabel(null, undefined)).toBe('免费体验');
  });
});
