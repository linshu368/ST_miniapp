import type { FastifyReply } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestLogger } from '../lib/logger.js';
import type { MiniappPaymentOrderRow } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { insertUserNotification } from '../lib/notifications.js';
import { handleZqPayWebhook } from './payment.js';

vi.mock('../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));

function createReply() {
  const state = {
    statusCode: 200,
    contentType: '',
    body: undefined as unknown,
  };
  const reply = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    type(contentType: string) {
      state.contentType = contentType;
      return this;
    },
    send(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, state };
}

function createLog(): RequestLogger {
  const logger = {
    sys: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    biz: {
      info: vi.fn(),
    },
  };
  return logger as unknown as RequestLogger;
}

function createOrder(overrides: Partial<MiniappPaymentOrderRow> = {}): MiniappPaymentOrderRow {
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
    created_at: '2026-08-21T09:00:00.000Z',
    expires_at: '2026-08-21T09:15:00.000Z',
    paid_at: null,
    ...overrides,
  };
}

function createNotify(overrides: Record<string, string> = {}) {
  return {
    pid: '55',
    trade_no: 'ZQ-order-1',
    out_trade_no: 'MA-order-1',
    type: 'wxpay',
    trade_status: 'TRADE_SUCCESS',
    money: '6.00',
    timestamp: Math.floor(Date.now() / 1000).toString(),
    sign: 'signed',
    sign_type: 'RSA',
    ...overrides,
  };
}

function createGateway(options: { merchant?: boolean; signature?: boolean } = {}) {
  return {
    isExpectedMerchant: vi.fn(() => options.merchant ?? true),
    verifyNotifySign: vi.fn(() => options.signature ?? true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleZqPayWebhook', () => {
  it('completes a valid order and writes one arrival notification', async () => {
    const order = createOrder();
    const orders = {
      findById: vi.fn(async () => order),
      complete: vi.fn(async () => createOrder({ status: 'completed', credits_added: true })),
    };
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1');
    expect(insertUserNotification).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      statusCode: 200,
      contentType: 'text/plain',
      body: 'success',
    });
  });

  it('does not notify twice when a completed order receives a repeated callback', async () => {
    const order = createOrder({ status: 'completed', credits_added: true });
    const orders = {
      findById: vi.fn(async () => order),
      complete: vi.fn(async () => order),
    };
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(orders.complete).toHaveBeenCalledOnce();
    expect(insertUserNotification).not.toHaveBeenCalled();
    expect(state.body).toBe('success');
  });

  it.each([
    ['merchant', createGateway({ merchant: false })],
    ['signature', createGateway({ signature: false })],
  ])('rejects an invalid %s', async (_case, gateway) => {
    const orders = {
      findById: vi.fn(async () => createOrder()),
      complete: vi.fn(async () => createOrder()),
    };
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, gateway, orders, createLog());

    expect(orders.findById).not.toHaveBeenCalled();
    expect(state).toMatchObject({ statusCode: 400, body: 'fail' });
  });

  it('rejects an amount mismatch without completing the order', async () => {
    const orders = {
      findById: vi.fn(async () => createOrder()),
      complete: vi.fn(async () => createOrder()),
    };
    const { reply, state } = createReply();

    await handleZqPayWebhook(
      createNotify({ money: '6.01' }),
      reply,
      createGateway(),
      orders,
      createLog()
    );

    expect(orders.complete).not.toHaveBeenCalled();
    expect(state).toMatchObject({ statusCode: 400, body: 'fail' });
  });

  it('acknowledges a non-success status without completing the order', async () => {
    const orders = {
      findById: vi.fn(async () => createOrder()),
      complete: vi.fn(async () => createOrder()),
    };
    const { reply, state } = createReply();

    await handleZqPayWebhook(
      createNotify({ trade_status: 'WAIT_BUYER_PAY' }),
      reply,
      createGateway(),
      orders,
      createLog()
    );

    expect(orders.findById).not.toHaveBeenCalled();
    expect(state.body).toBe('success');
  });
});
