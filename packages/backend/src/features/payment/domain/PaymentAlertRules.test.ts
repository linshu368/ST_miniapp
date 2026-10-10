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
const at = (
  isoText: string,
  id: string,
  user: string,
  status: 'pending' | 'completed' = 'pending'
) => ({
  orderId: id,
  userId: user,
  checkoutConfirmedAt: isoText,
  status,
  paidAt: status === 'completed' ? isoText : null,
  fulfillmentApplied: status === 'completed',
});
describe('V2 payment alert rules', () => {
  it('fires when one user has two unpaid orders inside five minutes', () => {
    const orders = [at(iso(1), 'a', 'same'), at(iso(2), 'b', 'same'), at(iso(1), 'c', 'other')];
    const fired = evaluatePaymentAlertRules(
      { orders, operations: [], productionWebhookBaseline: false },
      now
    );
    expect(fired.find((x) => x.rule_id === 'p0-user-unpaid-5m')?.state).toBe('firing');
    expect(
      evaluatePaymentAlertRules(
        { orders: orders.slice(0, 1), operations: [], productionWebhookBaseline: false },
        now
      ).find((x) => x.rule_id === 'p0-user-unpaid-5m')?.state
    ).toBe('healthy');
    expect(
      evaluatePaymentAlertRules(
        {
          orders: [at(iso(1), 'paid', 'same', 'completed'), at(iso(2), 'open', 'same')],
          operations: [],
          productionWebhookBaseline: false,
        },
        now
      ).find((x) => x.rule_id === 'p0-user-unpaid-5m')?.state
    ).toBe('healthy');
    expect(
      evaluatePaymentAlertRules(
        {
          orders: [at(iso(30), 'old-a', 'same'), at(iso(40), 'old-b', 'same')],
          operations: [],
          productionWebhookBaseline: false,
        },
        now
      ).find((x) => x.rule_id === 'p0-user-unpaid-5m')?.state
    ).toBe('healthy');
  });
  it('fires four consecutive unpaid orders without a time window', () => {
    const latestOrders = [
      at('2026-01-01T00:00:00.000Z', 'o1', 'u1'),
      at('2026-02-01T00:00:00.000Z', 'o2', 'u2'),
      at('2026-03-01T00:00:00.000Z', 'o3', 'u3'),
      at('2026-04-01T00:00:00.000Z', 'o4', 'u4'),
    ];
    expect(
      evaluatePaymentAlertRules(
        { orders: [], latestOrders, operations: [], productionWebhookBaseline: false },
        now
      ).find((x) => x.rule_id === 'p0-consecutive-unpaid')?.state
    ).toBe('firing');
    expect(
      evaluatePaymentAlertRules(
        {
          orders: [],
          latestOrders: [
            latestOrders[0]!,
            latestOrders[1]!,
            latestOrders[2]!,
            at('2026-05-01T00:00:00.000Z', 'paid', 'u5', 'completed'),
          ],
          operations: [],
          productionWebhookBaseline: false,
        },
        now
      ).find((x) => x.rule_id === 'p0-consecutive-unpaid')?.state
    ).toBe('healthy');
    expect(
      evaluatePaymentAlertRules(
        {
          orders: [],
          latestOrders: latestOrders.slice(0, 3),
          operations: [],
          productionWebhookBaseline: false,
        },
        now
      ).find((x) => x.rule_id === 'p0-consecutive-unpaid')?.state
    ).toBe('healthy');
  });
  it('keeps paused P0 rules from firing and leaves the webhook baseline healthy', () => {
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
    expect(values.find((x) => x.rule_id === 'p0-04')).toBeUndefined();
    expect(values.find((x) => x.rule_id === 'p0-01')).toBeUndefined();
    expect(values.find((x) => x.rule_id === 'p1-02')?.state).toBe('healthy');
    expect(values.find((x) => x.rule_id === 'p1-05')).toBeDefined();
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
    expect(value.fingerprint).toBe('test:payment:p0-user-unpaid-5m:all');
    expect(value.fingerprint).not.toContain('secret');
  });
});
