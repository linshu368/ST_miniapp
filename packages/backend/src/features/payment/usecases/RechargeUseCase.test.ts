import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_VIP_PLANS_CONFIG } from '@miniapp/shared';
import type { MiniappPaymentOrderRow } from '../../../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { RechargeUseCase } from './RechargeUseCase.js';
import { observePaymentOrderFailed } from './PaymentOrderTelemetry.js';
import { readVipStrategy, type VipStrategy } from '../../../platform/vip-strategy.js';

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
    isVipPurchaseEnabled: vi.fn(async () => false),
  };
});

vi.mock('./PaymentOrderTelemetry.js', () => ({
  observePaymentOrderFailed: vi.fn(),
  observePaymentOrderSettled: vi.fn(),
}));

vi.mock('../../../platform/vip-strategy.js', () => ({
  readVipStrategy: vi.fn(),
}));

function publishedStrategy(overrides: Partial<VipStrategy> = {}): VipStrategy {
  return {
    purchaseEnabled: false,
    remindersEnabled: false,
    plans: structuredClone(DEFAULT_VIP_PLANS_CONFIG),
    plansVersion: 1,
    discountRate: 0.95,
    discountVersion: 1,
    checkin: { mode: 'same_as_base' },
    checkinVersion: 1,
    limits: { voice: 3, basic_image: 3 },
    limitsVersion: 1,
    fallbacks: [],
    ...overrides,
  };
}

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
    product_type: 'credits',
    product_id: null,
    vip_duration_days: null,
    vip_bonus_credits: null,
    fulfillment_applied: false,
    vip_valid_until: null,
    next_reconcile_at: '2026-09-15T09:01:00.000Z',
    last_reconciled_at: null,
    reconcile_attempts: 0,
    reconcile_locked_until: null,
  };
}

describe('RechargeUseCase payment failure telemetry', () => {
  beforeEach(() => {
    vi.mocked(observePaymentOrderFailed).mockReset();
    vi.mocked(readVipStrategy).mockReset();
    vi.mocked(readVipStrategy).mockResolvedValue(publishedStrategy());
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

describe('RechargeUseCase product snapshots', () => {
  beforeEach(() => {
    vi.mocked(readVipStrategy).mockReset();
    vi.mocked(readVipStrategy).mockResolvedValue(publishedStrategy());
  });

  function harness() {
    const order = createOrder();
    const orders = {
      create: vi.fn(async (input: { id: string }) => ({ ...order, ...input })),
      markFailed: vi.fn(async () => undefined),
    };
    const gateway = {
      createPayment: vi.fn(async () => ({
        success: true,
        paymentUrl: 'https://pay.example/checkout',
      })),
    };
    return {
      order,
      orders,
      gateway,
      usecase: new RechargeUseCase(orders as never, gateway as never),
    };
  }

  it('keeps a credits plan on the server price when VIP purchase is closed', async () => {
    const { order, orders, gateway, usecase } = harness();
    await usecase.createOrder({
      userId: order.user_id,
      planId: 'plan-entry',
      paymentType: 'wxpay',
      clientIp: '127.0.0.1',
    });
    expect(orders.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product_type: 'credits',
        product_id: 'plan-entry',
        amount_cents: 600,
        credits_amount: 600,
        bonus_credits: 0,
        vip_duration_days: null,
        vip_bonus_credits: null,
      })
    );
    expect(gateway.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '6.00', productName: '星尘' })
    );
  });

  it('rejects VIP plans while the purchase switch is off and does not insert an order', async () => {
    const { order, orders, gateway, usecase } = harness();
    await expect(
      usecase.createOrder({
        userId: order.user_id,
        planId: 'week',
        paymentType: 'wxpay',
        clientIp: '127.0.0.1',
      })
    ).rejects.toThrow('VIP 购买未开放');
    expect(orders.create).not.toHaveBeenCalled();
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('snapshots week and month terms from the server catalog', async () => {
    vi.mocked(readVipStrategy).mockResolvedValue(publishedStrategy({ purchaseEnabled: true }));
    const week = harness();
    await week.usecase.createOrder({
      userId: week.order.user_id,
      planId: 'week',
      paymentType: 'wxpay',
      clientIp: '127.0.0.1',
    });
    expect(week.orders.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product_type: 'vip',
        product_id: 'week',
        amount_cents: 100,
        credits_amount: 0,
        bonus_credits: 0,
        vip_duration_days: 7,
        vip_bonus_credits: 0,
      })
    );
    expect(week.gateway.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '1.00', productName: '周卡' })
    );

    const month = harness();
    await month.usecase.createOrder({
      userId: month.order.user_id,
      planId: 'month',
      paymentType: 'alipay',
      clientIp: '127.0.0.1',
    });
    expect(month.orders.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product_type: 'vip',
        product_id: 'month',
        amount_cents: 200,
        credits_amount: 0,
        bonus_credits: 0,
        vip_duration_days: 31,
        vip_bonus_credits: 3000,
      })
    );
    expect(month.gateway.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '2.00', productName: '月卡' })
    );
  });

  it('rejects an unknown plan before creating an order', async () => {
    const { order, orders, usecase } = harness();
    await expect(
      usecase.createOrder({
        userId: order.user_id,
        planId: 'not-a-plan',
        paymentType: 'wxpay',
        clientIp: '127.0.0.1',
      })
    ).rejects.toThrow('支付套餐不存在');
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('keeps an existing order snapshot when the published price changes later', async () => {
    const plans = structuredClone(DEFAULT_VIP_PLANS_CONFIG);
    vi.mocked(readVipStrategy).mockImplementation(async () =>
      publishedStrategy({ purchaseEnabled: true, plans: structuredClone(plans) })
    );
    const { order, orders, usecase } = harness();
    await usecase.createOrder({
      userId: order.user_id,
      planId: 'week',
      paymentType: 'wxpay',
      clientIp: '127.0.0.1',
    });
    const first = vi.mocked(orders.create).mock.calls[0]?.[0];
    plans.week = { ...plans.week, price_cents: 2000, duration_days: 10 };
    await usecase.createOrder({
      userId: order.user_id,
      planId: 'week',
      paymentType: 'wxpay',
      clientIp: '127.0.0.1',
    });
    const second = vi.mocked(orders.create).mock.calls[1]?.[0];
    expect(first).toEqual(expect.objectContaining({ amount_cents: 100, vip_duration_days: 7 }));
    expect(second).toEqual(expect.objectContaining({ amount_cents: 2000, vip_duration_days: 10 }));
  });

  it('marks the order failed when the gateway rejects a VIP order', async () => {
    vi.mocked(readVipStrategy).mockResolvedValue(publishedStrategy({ purchaseEnabled: true }));
    const { order, orders } = harness();
    const gateway = {
      createPayment: vi.fn(async () => ({ success: false, errorMessage: 'gateway down' })),
    };
    const failing = new RechargeUseCase(orders as never, gateway as never);
    await expect(
      failing.createOrder({
        userId: order.user_id,
        planId: 'month',
        paymentType: 'wxpay',
        clientIp: '127.0.0.1',
      })
    ).rejects.toThrow('gateway down');
    expect(orders.markFailed).toHaveBeenCalledOnce();
  });

  it('does not call the gateway when the order insert fails', async () => {
    const order = createOrder();
    const orders = {
      create: vi.fn(async () => {
        throw new Error('db down');
      }),
      markFailed: vi.fn(async () => undefined),
    };
    const gateway = {
      createPayment: vi.fn(async () => ({
        success: true,
        paymentUrl: 'https://pay.example/checkout',
      })),
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
    expect(gateway.createPayment).not.toHaveBeenCalled();
    expect(orders.markFailed).not.toHaveBeenCalled();
  });
});
