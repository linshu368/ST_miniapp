import { describe, expect, it } from 'vitest';
import { formatFreeTrialBillingLabel, formatMediaBillingPreview } from './media-billing-label';

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

describe('formatMediaBillingPreview', () => {
  const billing = {
    billing_mode: 'free_trial' as const,
    wallet_policy: 'main_only' as const,
    price_credits: 15,
    price_label: '15 星尘',
    free_trial_limit: 3,
    free_trial_ordinal: 3,
    free_trials_remaining: 1,
  };
  it('does not keep promising free generation during refresh or after refresh failure', () => {
    expect(formatMediaBillingPreview(billing, true, false)).toBe('正在更新费用…');
    expect(formatMediaBillingPreview(billing, false, true)).not.toContain('免费');
    expect(formatMediaBillingPreview(undefined, false, false)).not.toContain('免费');
  });
  it('shows the server next ordinal and switches to paid after exhaustion', () => {
    expect(formatMediaBillingPreview(billing, false, false)).toContain('第 3/3 次');
    expect(formatMediaBillingPreview({ ...billing, billing_mode: 'paid' }, false, false)).toBe(
      '15 星尘 · 从充值星尘扣除'
    );
  });
  it('never advertises free trials for advanced images', () => {
    expect(formatMediaBillingPreview(billing, false, false, false)).toBe('15 星尘');
  });
});
