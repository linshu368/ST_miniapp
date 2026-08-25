import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestLogger } from '../lib/logger.js';
import type { MiniappPaymentOrderRow } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { PaymentQueryResult } from '../infrastructure/payment/ZqPaymentGateway.js';
import { insertUserNotification } from '../lib/notifications.js';
import { handleZqPayWebhook } from './payment.js';
import { reconcileWithGateway } from '../features/payment/usecases/PaymentSettlement.js';
import { toPaymentOrder } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';

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

/** 子千易实测不下发 sign_type / timestamp（见 0ce6eb2），所以基准回调不带这两个字段，
 *  需要它们的用例自己加。 */
function createNotify(overrides: Record<string, string> = {}) {
  return {
    pid: '55',
    trade_no: 'ZQ-order-1',
    out_trade_no: 'MA-order-1',
    type: 'wxpay',
    trade_status: 'TRADE_SUCCESS',
    money: '6.00',
    sign: 'signed',
    ...overrides,
  };
}

function createOrders(order = createOrder()) {
  return {
    findById: vi.fn(async () => order),
    complete: vi.fn(async () => createOrder({ status: 'completed', credits_added: true })),
    reopenExpired: vi.fn(async () => undefined),
  };
}

function createGateway(options: { merchant?: boolean; signature?: boolean } = {}) {
  return {
    isExpectedMerchant: vi.fn(() => options.merchant ?? true),
    verifyNotifySign: vi.fn(() => options.signature ?? true),
  };
}

function warnReasons(log: RequestLogger): string[] {
  const warn = log.sys.warn as unknown as { mock: { calls: unknown[][] } };
  return warn.mock.calls
    .map((call) => call[0] as { reason?: string })
    .map((payload) => payload?.reason)
    .filter((reason): reason is string => typeof reason === 'string');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleZqPayWebhook', () => {
  it('completes a valid order and writes one arrival notification', async () => {
    const orders = createOrders();
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

  it('accepts a callback that carries sign_type=RSA and a fresh timestamp', async () => {
    const orders = createOrders();
    const { reply, state } = createReply();

    await handleZqPayWebhook(
      createNotify({ sign_type: 'RSA', timestamp: Math.floor(Date.now() / 1000).toString() }),
      reply,
      createGateway(),
      orders,
      createLog()
    );

    expect(orders.complete).toHaveBeenCalledOnce();
    expect(state.body).toBe('success');
  });

  it('does not notify twice when a completed order receives a repeated callback', async () => {
    const order = createOrder({ status: 'completed', credits_added: true });
    const orders = {
      findById: vi.fn(async () => order),
      complete: vi.fn(async () => order),
      reopenExpired: vi.fn(async () => undefined),
    };
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(orders.complete).toHaveBeenCalledOnce();
    expect(orders.reopenExpired).not.toHaveBeenCalled();
    expect(insertUserNotification).not.toHaveBeenCalled();
    expect(state.body).toBe('success');
  });

  it('reopens an order that expired before the callback arrived, then credits it', async () => {
    const orders = createOrders(createOrder({ status: 'expired' }));
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(orders.reopenExpired).toHaveBeenCalledWith('MA-order-1');
    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1');
    expect(insertUserNotification).toHaveBeenCalledOnce();
    expect(state.body).toBe('success');
  });

  it('does not reopen an expired order that was already credited', async () => {
    const orders = createOrders(createOrder({ status: 'expired', credits_added: true }));
    const { reply } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(orders.reopenExpired).not.toHaveBeenCalled();
  });

  it.each([
    ['merchant_mismatch', createGateway({ merchant: false })],
    ['invalid_signature', createGateway({ signature: false })],
  ])('rejects a callback with reason %s', async (reason, gateway) => {
    const orders = createOrders();
    const { reply, state } = createReply();
    const log = createLog();

    await handleZqPayWebhook(createNotify(), reply, gateway, orders, log);

    expect(orders.findById).not.toHaveBeenCalled();
    expect(warnReasons(log)).toEqual([reason]);
    expect(state).toMatchObject({ statusCode: 400, body: 'fail' });
  });

  it('rejects a callback without a merchant order id', async () => {
    const orders = createOrders();
    const { reply, state } = createReply();
    const log = createLog();
    const { out_trade_no: _omitted, ...notify } = createNotify();

    await handleZqPayWebhook(notify, reply, createGateway(), orders, log);

    expect(warnReasons(log)).toEqual(['missing_order_id']);
    expect(state).toMatchObject({ statusCode: 400, body: 'fail' });
  });

  it('rejects a callback whose timestamp is outside the replay window', async () => {
    const orders = createOrders();
    const { reply, state } = createReply();
    const log = createLog();
    const hourAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000).toString();

    await handleZqPayWebhook(
      createNotify({ timestamp: hourAgo }),
      reply,
      createGateway(),
      orders,
      log
    );

    expect(orders.findById).not.toHaveBeenCalled();
    expect(warnReasons(log)).toEqual(['stale_timestamp']);
    expect(state).toMatchObject({ statusCode: 400, body: 'fail' });
  });

  it('rejects an amount mismatch without completing the order', async () => {
    const orders = createOrders();
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
    const orders = createOrders();
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

describe('reconcileWithGateway', () => {
  function createQueryGateway(result: PaymentQueryResult) {
    return { queryOrder: vi.fn(async () => result) };
  }

  it('credits a pending order once the vendor reports it as paid', async () => {
    const orders = createOrders();
    const gateway = createQueryGateway({
      success: true,
      paid: true,
      amount: '6.00',
      tradeNo: 'ZQ-order-1',
    });

    const changed = await reconcileWithGateway(
      toPaymentOrder(createOrder({ id: 'MA-query-paid' })),
      gateway,
      orders,
      createLog()
    );

    expect(gateway.queryOrder).toHaveBeenCalledWith('MA-query-paid');
    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1');
    expect(changed).toBe(true);
  });

  it('credits an expired order the vendor reports as paid', async () => {
    const orders = createOrders(createOrder({ status: 'expired' }));
    const gateway = createQueryGateway({ success: true, paid: true, amount: '6.00' });

    const changed = await reconcileWithGateway(
      toPaymentOrder(createOrder({ id: 'MA-query-expired', status: 'expired' })),
      gateway,
      orders,
      createLog()
    );

    expect(orders.reopenExpired).toHaveBeenCalledOnce();
    expect(changed).toBe(true);
  });

  it('leaves the order alone when the vendor reports it unpaid', async () => {
    const orders = createOrders();
    const gateway = createQueryGateway({ success: true, paid: false });

    const changed = await reconcileWithGateway(
      toPaymentOrder(createOrder({ id: 'MA-query-unpaid' })),
      gateway,
      orders,
      createLog()
    );

    expect(orders.complete).not.toHaveBeenCalled();
    expect(changed).toBe(false);
  });

  it('does not query a terminal order at all', async () => {
    const orders = createOrders();
    const gateway = createQueryGateway({ success: true, paid: true, amount: '6.00' });

    const changed = await reconcileWithGateway(
      toPaymentOrder(createOrder({ id: 'MA-query-done', status: 'completed' })),
      gateway,
      orders,
      createLog()
    );

    expect(gateway.queryOrder).not.toHaveBeenCalled();
    expect(changed).toBe(false);
  });

  it('throttles repeated polling of the same order', async () => {
    const orders = createOrders();
    const gateway = createQueryGateway({ success: true, paid: false });
    const order = toPaymentOrder(createOrder({ id: 'MA-query-throttled' }));

    await reconcileWithGateway(order, gateway, orders, createLog());
    await reconcileWithGateway(order, gateway, orders, createLog());

    expect(gateway.queryOrder).toHaveBeenCalledOnce();
  });

  it('keeps the order pending when the vendor amount disagrees', async () => {
    const orders = createOrders();
    const gateway = createQueryGateway({ success: true, paid: true, amount: '6.01' });

    const changed = await reconcileWithGateway(
      toPaymentOrder(createOrder({ id: 'MA-query-mismatch' })),
      gateway,
      orders,
      createLog()
    );

    expect(orders.complete).not.toHaveBeenCalled();
    expect(changed).toBe(false);
  });
});

// 回调面回归护栏：厂商用什么方法和 Content-Type 推送通知不由我们决定，
// GET query 和表单 POST 两条都必须能落到同一个 handler。
const routeOrders = {
  findById: vi.fn(async () => createOrder()),
  complete: vi.fn(async () => createOrder({ status: 'completed', credits_added: true })),
  reopenExpired: vi.fn(async () => undefined),
  expirePendingForUser: vi.fn(async () => 0),
  expirePendingByIdForUser: vi.fn(async () => undefined),
  findByIdForUser: vi.fn(async () => null),
  listByUser: vi.fn(async () => []),
  markFailed: vi.fn(async () => undefined),
  create: vi.fn(async () => createOrder()),
};

vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ schema: () => ({}) }),
}));

vi.mock(
  '../infrastructure/repositories/MiniappPaymentOrderRepository.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../infrastructure/repositories/MiniappPaymentOrderRepository.js')
      >();
    return {
      ...actual,
      MiniappPaymentOrderRepository: class {
        constructor() {
          return routeOrders;
        }
      },
    };
  }
);

// 刻意保留真实网关的判定形状（认商户号、要求 sign 存在），否则「回跳没签名也不能入账」
// 这类用例会被一个永远返回 true 的 stub 蒙过去。
vi.mock('../infrastructure/payment/ZqPaymentGateway.js', () => ({
  ZqPaymentGateway: class {
    isExpectedMerchant(pid: string | undefined) {
      return pid === '55';
    }
    verifyNotifySign(notifyData: { sign?: string }) {
      return Boolean(notifyData.sign);
    }
    async queryOrder() {
      return { success: false, errorMessage: 'not used in these tests' };
    }
  },
}));

async function buildWebhookApp() {
  const { default: paymentRoutes } = await import('./payment.js');
  const app = Fastify({ logger: false });
  await app.register(paymentRoutes);
  await app.ready();
  return app;
}

describe('POST/GET /api/payment/webhook/zqpay', () => {
  const notify = createNotify();

  it('credits the order for a form-encoded POST callback', async () => {
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/payment/webhook/zqpay',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(notify).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('success');
    expect(routeOrders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1');

    await app.close();
  });

  it('credits the order for a query-string GET callback', async () => {
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/payment/webhook/zqpay?${new URLSearchParams(notify).toString()}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('success');
    expect(routeOrders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1');

    await app.close();
  });
});

// 厂商《支付结果通知》把 return_url 也定义为一条支付结果通知，参数与异步通知相同。
// 异步通知实测有整条没推的订单，所以回跳这条必须也能入账。
describe('GET /api/payment/return', () => {
  beforeEach(() => {
    // 回跳会去解析 Bot username，别让测试打真实的 Telegram API。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('credits the order carried by a verified sync return', async () => {
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/payment/return?${new URLSearchParams(createNotify()).toString()}`,
    });

    expect(response.statusCode).toBe(302);
    expect(routeOrders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1');

    await app.close();
  });

  it('still navigates without crediting when the return is not a success notice', async () => {
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/payment/return?${new URLSearchParams(
        createNotify({ trade_status: 'WAIT_BUYER_PAY' })
      ).toString()}`,
    });

    expect(response.statusCode).toBe(302);
    expect(routeOrders.complete).not.toHaveBeenCalled();

    await app.close();
  });

  it('still navigates when the return carries no signature at all', async () => {
    const app = await buildWebhookApp();
    const { sign: _omitted, ...unsigned } = createNotify();

    const response = await app.inject({
      method: 'GET',
      url: `/api/payment/return?${new URLSearchParams(unsigned).toString()}`,
    });

    expect(response.statusCode).toBe(302);
    expect(routeOrders.complete).not.toHaveBeenCalled();

    await app.close();
  });
});
