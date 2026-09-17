import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MiniappPaymentOrderRow } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { RechargeUseCase } from './RechargeUseCase.js';
import { observePaymentOrderFailed } from './PaymentOrderTelemetry.js';

vi.mock('../../../platform/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/config.js')>();
  return {
    config: {
      ...actual.config,
      payment: { ...actual.config.payment, enabled: true },
    },
  };
});

vi.mock('../domain/rechargeRules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../domain/rechargeRules.js')>();
  return {
    ...actual,
    findPaymentPlan: vi.fn(async (planId: string) =>
      planId === 'plan-entry'
        ? {
            id: 'plan-entry',
            price_cents: 600,
            original_price_cents: null,
            credits_amount: 600,
            bonus_credits: 0,
            variant: 'entry' as const,
            badge_text: null,
            sub_copy: null,
            highlight_text: null,
          }
        : undefined
    ),
  };
});

vi.mock('./PaymentOrderTelemetry.js', () => ({
  observePaymentOrderFailed: vi.fn(),
  observePaymentOrderSettled: vi.fn(),
}));

function createOrder(): MiniappPaymentOrderRow {
  return {
    id: 'MA-order-1',
    user_id: '00000000-0000-0000-0000-000000000001',
    status: 'pending',
    payment_type: 'wxpay',
    amount_cents: 600,
    credits_amount: 600,
    bonus_credits: 0,
    provider_transaction_id: null,
    credits_added: false,
    created_at: '2026-09-15T09:00:00.000Z',
    expires_at: '2026-09-15T09:15:00.000Z',
    paid_at: null,
    settled_by: null,
    next_reconcile_at: '2026-09-15T09:01:00.000Z',
    last_reconciled_at: null,
    reconcile_attempts: 0,
    reconcile_locked_until: null,
  };
}

describe('RechargeUseCase payment failure telemetry', () => {
  beforeEach(() => {
    vi.mocked(observePaymentOrderFailed).mockReset();
  });

  it('emits payment_order_failed only after markFailed persists', async () => {
    const order = createOrder();
    const orders = {
      create: vi.fn(async (input: { id: string }) => ({ ...order, id: input.id })),
      markFailed: vi.fn(async () => undefined),
    };
    const gateway = {
      createPayment: vi.fn(async () => ({ success: false, errorMessage: 'gateway down' })),
    };
    const usecase = new RechargeUseCase(orders as never, gateway as never);

    await expect(
      usecase.createOrder({
        userId: order.user_id,
        planId: 'plan-entry',
        paymentType: 'wxpay',
        clientIp: '127.0.0.1',
      })
    ).rejects.toThrow('gateway down');

    const createdId = vi.mocked(orders.create).mock.calls[0]?.[0].id;
    expect(createdId).toEqual(expect.stringMatching(/^MA_/));
    expect(orders.markFailed).toHaveBeenCalledWith(createdId);
    expect(observePaymentOrderFailed).toHaveBeenCalledWith(
      {
        orderId: createdId,
        userId: order.user_id,
        paymentType: 'wxpay',
        settledBy: null,
      },
      expect.anything()
    );
    expect(vi.mocked(observePaymentOrderFailed).mock.invocationCallOrder[0]).toBeGreaterThan(
      orders.markFailed.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('does not emit when markFailed itself fails to persist', async () => {
    const order = createOrder();
    const persistError = new Error('db down');
    const orders = {
      create: vi.fn(async () => order),
      markFailed: vi.fn(async () => {
        throw persistError;
      }),
    };
    const gateway = {
      createPayment: vi.fn(async () => ({ success: false, errorMessage: 'gateway down' })),
    };
    const usecase = new RechargeUseCase(orders as never, gateway as never);

    await expect(
      usecase.createOrder({
        userId: order.user_id,
        planId: 'plan-entry',
        paymentType: 'wxpay',
        clientIp: '127.0.0.1',
      })
    ).rejects.toThrow('db down');

    expect(observePaymentOrderFailed).not.toHaveBeenCalled();
  });
});
