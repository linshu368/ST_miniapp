import { describe, expect, it } from 'vitest';
import { aggregatePaymentAttempts, summarizePaymentAttempts } from './PaymentAlertAggregation.js';
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 9, minutes)).toISOString();
const order = (
  id: string,
  minutes: number,
  status: 'pending' | 'completed' | 'expired' = 'pending'
) => ({
  orderId: id,
  userId: 'u',
  checkoutConfirmedAt: at(minutes),
  status,
  paidAt: status === 'completed' ? at(minutes + 1) : null,
  fulfillmentApplied: status === 'completed',
});
describe('payment alert attempts', () => {
  it('merges a retry within fifteen minutes and eliminates suspicion when any order completes', () => {
    const result = aggregatePaymentAttempts([
      order('a', 0, 'expired'),
      order('b', 15, 'completed'),
    ]);
    expect(result.attempts).toHaveLength(1);
    expect(
      summarizePaymentAttempts(result.attempts, Date.parse(at(30)), 600_000).suspectedFailedAttempts
    ).toBe(0);
  });
  it('starts another attempt after fifteen minutes and excludes invalid confirmation time', () => {
    const result = aggregatePaymentAttempts([
      order('a', 0),
      order('b', 16),
      { ...order('bad', 1), checkoutConfirmedAt: 'bad-time' },
    ]);
    expect(result.attempts).toHaveLength(2);
    expect(result.excludedOrderIds).toEqual(['bad']);
  });
});
