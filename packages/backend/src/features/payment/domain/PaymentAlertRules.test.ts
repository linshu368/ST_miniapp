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
  status: 'pending' | 'completed' = 'pending',
  telegramId: string | null = null
) => ({
  orderId: id,
  userId: user,
  telegramId,
  checkoutConfirmedAt: isoText,
  status,
  paidAt: status === 'completed' ? isoText : null,
  fulfillmentApplied: status === 'completed',
});
describe('V2 payment alert rules', () => {
  it('fires when one user has two unpaid orders inside five minutes', () => {
    const orders = [
      at(iso(1), 'order-a', 'same', 'pending', '888001'),
      at(iso(2), 'order-b', 'same', 'pending', '888001'),
      at(iso(1), 'order-c', 'other', 'pending', '888002'),
    ];
    const fired = evaluatePaymentAlertRules(
      { orders, operations: [], productionWebhookBaseline: false },
      now
    );
    const repeat = fired.find((x) => x.rule_id === 'p0-user-unpaid-5m');
    expect(repeat?.state).toBe('firing');
    expect(repeat?.title).toBe('P0 同一用户5分钟内至少2单未支付成功');
    expect(repeat?.summary).toContain('tg-id: 888001');
    expect(repeat?.summary).toContain('过去5分钟未成功支付: 2 单');
    expect(repeat?.summary).toContain('订单号: order-a');
    expect(repeat?.summary).toContain('时间: 2026-10-10 17:59:00 +08:00');
    expect(repeat?.summary).not.toContain('888002');
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
      at('2026-01-01T00:00:00.000Z', 'o1', 'u1', 'pending', '1001'),
      at('2026-02-01T00:00:00.000Z', 'o2', 'u2', 'pending', '1002'),
      at('2026-03-01T00:00:00.000Z', 'o3', 'u3', 'pending', '1003'),
      at('2026-04-01T00:00:00.000Z', 'o4', 'u4', 'pending', '1004'),
    ];
    const streak = evaluatePaymentAlertRules(
      { orders: [], latestOrders, operations: [], productionWebhookBaseline: false },
      now
    ).find((x) => x.rule_id === 'p0-consecutive-unpaid');
    expect(streak?.state).toBe('firing');
    expect(streak?.title).toBe('P0 连续4个订单均未支付成功');
    expect(streak?.summary).toBe(
      [
        '1. tg-id: 1001 订单号: o1',
        '2. tg-id: 1002 订单号: o2',
        '3. tg-id: 1003 订单号: o3',
        '4. tg-id: 1004 订单号: o4',
      ].join('\n')
    );
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
