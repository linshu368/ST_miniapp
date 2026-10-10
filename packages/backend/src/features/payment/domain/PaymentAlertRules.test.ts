import { describe, expect, it } from 'vitest';
import { evaluatePaymentAlertRules } from './PaymentAlertRules.js';
const now = new Date('2026-10-10T10:00:00.000Z');
const iso = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const order = (
  id: string,
  user: string,
  status: 'pending' | 'completed' | 'expired' = 'pending'
) => ({
  orderId: id,
  userId: user,
  checkoutConfirmedAt: iso(12),
  status,
  paidAt: status === 'completed' ? iso(1) : null,
  fulfillmentApplied: status === 'completed',
});
describe('V2 payment alert rules', () => {
  it('fires P0-01 only at the exact low-volume and failure thresholds', () => {
    const operations = Array.from({ length: 5 }, (_, i) => ({
      event_kind: 'gateway_create',
      outcome: 'failed',
      trigger: 'create_order',
      occurred_at: iso(i),
      error_class: 'timeout',
      order_id: `o${i}`,
      user_id: `u${i % 2}`,
    }));
    const fired = evaluatePaymentAlertRules(
      { orders: [], operations, productionWebhookBaseline: false },
      now
    );
    expect(fired.find((x) => x.rule_id === 'p0-01')?.state).toBe('firing');
    expect(
      evaluatePaymentAlertRules(
        { orders: [], operations: operations.slice(1), productionWebhookBaseline: false },
        now
      ).find((x) => x.rule_id === 'p0-01')?.state
    ).toBe('healthy');
  });
  it('keeps zero webhook baseline healthy and makes paid-but-unfulfilled P0 independently firing', () => {
    const paid = {
      ...order('paid', 'u', 'completed'),
      fulfillmentApplied: false,
      status: 'pending' as const,
      paidAt: iso(2),
    };
    const values = evaluatePaymentAlertRules(
      { orders: [paid], operations: [], productionWebhookBaseline: false },
      now
    );
    expect(values.find((x) => x.rule_id === 'p0-04')?.state).toBe('firing');
    expect(values.find((x) => x.rule_id === 'p1-02')?.state).toBe('healthy');
  });
  it('uses a stable fingerprint without rule version, time, severity, or user identifiers', () => {
    const value = evaluatePaymentAlertRules(
      {
        orders: [order('secret-order', 'secret-user')],
        operations: [],
        productionWebhookBaseline: false,
      },
      now
    )[0]!;
    expect(value.fingerprint).toBe('test:payment:p0-01:all');
    expect(value.fingerprint).not.toContain('secret');
  });
});
