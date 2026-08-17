import { describe, expect, it } from 'vitest';
import {
  calculateFallbackDeduction,
  calculateUsageDeduction,
  getInitialBillingDecision,
  resolveFixedDeduction,
  resolveUsageBillingGate,
  shouldRecordUsageCharge,
} from '../features/billing/usage-pricing.js';

const fixedDeduction = {
  freeQuotaExhausted: 10,
  light: 15,
  standard: 30,
  premium: 50,
};

describe('resolveFixedDeduction', () => {
  it('keeps free quota rounds free and charges every free model 10 after exhaustion', () => {
    expect(
      resolveFixedDeduction({
        defaultModelMarkup: 0,
        effectiveModelMarkup: 0,
        modelTier: 'standard',
        config: fixedDeduction,
      })
    ).toEqual({ amount: 0, category: 'free_quota' });
    expect(
      resolveFixedDeduction({
        defaultModelMarkup: 0,
        effectiveModelMarkup: 3,
        modelTier: 'standard',
        config: fixedDeduction,
      })
    ).toEqual({ amount: 10, category: 'free_quota_exhausted' });
  });

  it('charges paid light, standard and premium tiers fixed amounts', () => {
    expect(
      resolveFixedDeduction({
        defaultModelMarkup: 1,
        effectiveModelMarkup: 1,
        modelTier: 'light',
        config: fixedDeduction,
      })
    ).toEqual({ amount: 15, category: 'light' });
    expect(
      resolveFixedDeduction({
        defaultModelMarkup: 2.5,
        effectiveModelMarkup: 2.5,
        modelTier: 'standard',
        config: fixedDeduction,
      })
    ).toEqual({ amount: 30, category: 'standard' });
    expect(
      resolveFixedDeduction({
        defaultModelMarkup: 2.5,
        effectiveModelMarkup: 2.5,
        modelTier: 'premium',
        config: fixedDeduction,
      })
    ).toEqual({ amount: 50, category: 'premium' });
  });

  it('falls unknown paid tiers back to the standard amount', () => {
    expect(
      resolveFixedDeduction({
        defaultModelMarkup: 2.5,
        effectiveModelMarkup: 2.5,
        modelTier: null,
        config: fixedDeduction,
      })
    ).toEqual({ amount: 30, category: 'standard_fallback' });
  });
});

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

describe('getInitialBillingDecision', () => {
  it('records paid calls as pending with zero charge when usage is late', () => {
    expect(
      getInitialBillingDecision({ usageCost: null, exchangeRate: 680, modelMarkup: 2.5 })
    ).toEqual({ amount: 0, hasActualUsage: false, pending: true });
  });

  it('keeps free calls at zero even when OpenRouter reports a cost', () => {
    expect(
      getInitialBillingDecision({ usageCost: 12.34, exchangeRate: 680, modelMarkup: 0 })
    ).toEqual({ amount: 0, hasActualUsage: true, pending: false });
  });

  it('charges paid calls once actual usage is available', () => {
    expect(
      getInitialBillingDecision({ usageCost: 0.01, exchangeRate: 680, modelMarkup: 2.5 })
    ).toEqual({ amount: 17, hasActualUsage: true, pending: false });
  });

  it('uses a fixed deduction immediately even when provider usage is late', () => {
    expect(
      getInitialBillingDecision({
        usageCost: null,
        exchangeRate: 680,
        modelMarkup: 2.5,
        fixedDeduction: 30,
      })
    ).toEqual({ amount: 30, hasActualUsage: false, pending: false });
  });
});

describe('shouldRecordUsageCharge', () => {
  it('records every generation outcome as spending detail', () => {
    expect(shouldRecordUsageCharge('success', 2.5)).toBe(true);
    expect(shouldRecordUsageCharge('upstream_error', 2.5)).toBe(true);
    expect(shouldRecordUsageCharge('stream_interrupted', 2.5)).toBe(true);
    expect(shouldRecordUsageCharge('error', 2.5)).toBe(false);
  });
});

describe('resolveUsageBillingGate', () => {
  it('only bills natural stop completions', () => {
    expect(resolveUsageBillingGate({ status: 'success', finishReason: 'stop' })).toBe('billable');
    expect(resolveUsageBillingGate({ status: 'success', finishReason: null })).toBe(
      'pending_finish_reason'
    );
    expect(resolveUsageBillingGate({ status: 'success', finishReason: 'content_filter' })).toBe(
      'non_billable'
    );
    expect(resolveUsageBillingGate({ status: 'success', finishReason: 'length' })).toBe(
      'non_billable'
    );
    expect(resolveUsageBillingGate({ status: 'success', finishReason: 'tool_calls' })).toBe(
      'non_billable'
    );
    expect(resolveUsageBillingGate({ status: 'stream_interrupted', finishReason: null })).toBe(
      'non_billable'
    );
  });
});
