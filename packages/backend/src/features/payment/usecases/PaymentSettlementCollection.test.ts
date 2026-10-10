import { describe, expect, it, vi } from 'vitest';

import type { MiniappPaymentOrderRow } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { settlePaidOrder } from './PaymentSettlement.js';
import type { SettlementLogger } from './PaymentSettlement.js';

vi.mock('../../../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/invite-rewards.js', () => ({
  checkInviteFirstPaidReward: vi.fn(async () => undefined),
}));
vi.mock('./PaymentOrderTelemetry.js', () => ({ observePaymentOrderSettled: vi.fn() }));

function order(): MiniappPaymentOrderRow {
  return {
    id: 'MA-collection-1',
    user_id: '00000000-0000-0000-0000-000000000001',
    status: 'pending',
    payment_type: 'wxpay',
    amount_cents: 600,
    credits_amount: 600,
    bonus_credits: 0,
    provider_transaction_id: null,
    credits_added: false,
    created_at: '2026-10-10T11:00:00.000Z',
    expires_at: '2026-10-10T11:15:00.000Z',
    paid_at: null,
    settled_by: null,
    product_type: 'credits',
    product_id: null,
    vip_duration_days: null,
    vip_bonus_credits: null,
    fulfillment_applied: false,
    vip_valid_until: null,
    next_reconcile_at: '2026-10-10T11:01:00.000Z',
    last_reconciled_at: null,
    reconcile_attempts: 0,
    reconcile_locked_until: null,
  };
}

function logger(): SettlementLogger {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { biz: sink, sys: sink } as unknown as SettlementLogger;
}

describe('settlement operation event semantics', () => {
  it.each(['webhook', 'return', 'query', 'cron'] as const)(
    'records the %s settlement entrance without changing fulfillment',
    async (source) => {
      const row = order();
      const orders = {
        findById: vi.fn(async () => row),
        complete: vi.fn(async () => ({
          ...row,
          status: 'completed' as const,
          credits_added: true,
        })),
        reopenExpired: vi.fn(async () => undefined),
      };
      const events = { recordOperationEvent: vi.fn(async () => undefined) };

      await expect(
        settlePaidOrder(
          { orderId: row.id, paidAmount: '6.00', providerTransactionId: 'ZQ-collection-1' },
          orders,
          logger(),
          source,
          events
        )
      ).resolves.toBe('completed');
      await Promise.resolve();
      await Promise.resolve();
      expect(events.recordOperationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_kind: 'settlement',
          outcome: 'succeeded',
          order_id: row.id,
        })
      );
      expect(orders.complete).toHaveBeenCalledWith(row.id, 'ZQ-collection-1', source);
    }
  );
});
