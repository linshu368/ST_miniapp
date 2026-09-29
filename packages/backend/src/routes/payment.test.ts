import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestLogger } from '../lib/logger.js';
import type { MiniappPaymentOrderRow } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { PaymentQueryResult } from '../infrastructure/payment/ZqPaymentGateway.js';
import { insertUserNotification } from '../lib/notifications.js';
import { checkInviteFirstPaidReward } from '../lib/invite-rewards.js';
import { handleZqPayWebhook } from './payment.js';
import {
  isOrderFulfilled,
  reconcileWithGateway,
  settlePaidOrder,
} from '../features/payment/usecases/PaymentSettlement.js';
import { toPaymentOrder } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { observePaymentOrderSettled } from '../features/payment/usecases/PaymentOrderTelemetry.js';

vi.mock('../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));

vi.mock('../lib/invite-rewards.js', () => ({
  checkInviteFirstPaidReward: vi.fn(async () => undefined),
}));

vi.mock('../features/payment/usecases/PaymentOrderTelemetry.js', () => ({
  observePaymentOrderSettled: vi.fn(),
  observePaymentOrderFailed: vi.fn(),
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
    settled_by: null,
    product_type: 'credits',
    product_id: null,
    vip_duration_days: null,
    vip_bonus_credits: null,
    fulfillment_applied: false,
    vip_valid_until: null,
    next_reconcile_at: '2026-08-21T09:01:00.000Z',
    last_reconciled_at: null,
    reconcile_attempts: 0,
    reconcile_locked_until: null,
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
    complete: vi.fn(
      async (_id: string, _txid: string | null, settledBy: MiniappPaymentOrderRow['settled_by']) =>
        createOrder({
          ...order,
          id: order.id,
          status: 'completed',
          credits_added: true,
          settled_by: settledBy,
        })
    ),
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

    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1', 'webhook');
    expect(insertUserNotification).toHaveBeenCalledOnce();
    expect(observePaymentOrderSettled).toHaveBeenCalledWith(
      {
        orderId: 'MA-order-1',
        userId: '00000000-0000-0000-0000-000000000001',
        paymentType: 'wxpay',
        settledBy: 'webhook',
      },
      expect.anything()
    );
    expect(state).toMatchObject({
      statusCode: 200,
      contentType: 'text/plain',
      body: 'success',
    });
  });

  it('runs the invite first-paid reward hook for the credited order', async () => {
    const orders = createOrders();
    const { reply } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(checkInviteFirstPaidReward).toHaveBeenCalledWith(
      { userId: '00000000-0000-0000-0000-000000000001', orderId: 'MA-order-1' },
      expect.anything()
    );
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
    const order = createOrder({ status: 'completed', credits_added: true, settled_by: 'webhook' });
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
    // 到账通知不重发，但发奖判定要重跑：判定自带幂等，重放是上一次失败判定唯一的重试机会。
    expect(checkInviteFirstPaidReward).toHaveBeenCalledOnce();
    expect(state.body).toBe('success');
  });

  it('does not emit settlement telemetry when complete fails to persist', async () => {
    const orders = createOrders();
    orders.complete.mockRejectedValueOnce(new Error('db down'));
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(observePaymentOrderSettled).not.toHaveBeenCalled();
    expect(state).toMatchObject({ statusCode: 500, body: 'fail' });
  });

  it('keeps settlement successful when terminal telemetry throws', async () => {
    vi.mocked(observePaymentOrderSettled).mockImplementationOnce(() => {
      throw new Error('posthog down');
    });
    const orders = createOrders();
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(orders.complete).toHaveBeenCalledOnce();
    expect(state.body).toBe('success');
  });

  it('does not wait for hanging telemetry before returning completed', async () => {
    vi.mocked(observePaymentOrderSettled).mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    const result = await settlePaidOrder(
      { orderId: 'MA-order-1', paidAmount: '6.00', providerTransactionId: 'ZQ-order-1' },
      createOrders(),
      createLog(),
      'webhook'
    );
    expect(result).toBe('completed');
  });

  it('reopens an order that expired before the callback arrived, then credits it', async () => {
    const orders = createOrders(createOrder({ status: 'expired' }));
    const { reply, state } = createReply();

    await handleZqPayWebhook(createNotify(), reply, createGateway(), orders, createLog());

    expect(orders.reopenExpired).toHaveBeenCalledWith('MA-order-1');
    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1', 'webhook');
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
    expect(observePaymentOrderSettled).not.toHaveBeenCalled();
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
    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1', 'query');
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
  expirePendingByIdForUser: vi.fn(async () => undefined),
  findByIdForUser: vi.fn(async () => null),
  listByUser: vi.fn(async () => []),
  markFailed: vi.fn(async () => undefined),
  create: vi.fn(async () => createOrder()),
};

// 整个模块被替换掉，所以两个入口都得给：现在业务代码走的是 getDomainDb，
// 少一个就会在被 mock 的调用链里报 "getDomainDb is not a function"。
vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ schema: () => ({}) }),
  getDomainDb: () => ({}),
}));

vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: vi.fn(async () => ({
    id: '00000000-0000-0000-0000-000000000001',
  })),
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

describe('GET /api/payment/orders', () => {
  it('lists orders without expiring pending rows as a read side effect', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    const app = await buildWebhookApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/payment/orders',
      });

      expect(response.statusCode).toBe(200);
      expect(routeOrders.listByUser).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });
});

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
    expect(routeOrders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1', 'webhook');

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
    expect(routeOrders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1', 'webhook');

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
    expect(routeOrders.complete).toHaveBeenCalledWith('MA-order-1', 'ZQ-order-1', 'return');

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

describe('toPaymentOrder', () => {
  it('maps settled_by for both completed and historical rows', () => {
    expect(toPaymentOrder(createOrder({ settled_by: 'return' })).settled_by).toBe('return');
    expect(toPaymentOrder(createOrder({ settled_by: null })).settled_by).toBeNull();
  });

  it('keeps the same mapped shape used by order detail and order list', () => {
    const mapped = toPaymentOrder(
      createOrder({
        id: 'MA-shared-map',
        status: 'completed',
        paid_at: '2026-08-21T09:02:00.000Z',
        settled_by: 'query',
      })
    );
    expect(mapped).toEqual({
      id: 'MA-shared-map',
      status: 'completed',
      payment_type: 'wxpay',
      amount_cents: 600,
      credits_amount: 600,
      bonus_credits: 0,
      created_at: '2026-08-21T09:00:00.000Z',
      expires_at: '2026-08-21T09:15:00.000Z',
      paid_at: '2026-08-21T09:02:00.000Z',
      provider_transaction_id: null,
      settled_by: 'query',
      product_type: 'credits',
      product_id: null,
      fulfillment_applied: false,
      vip_duration_days: null,
      vip_bonus_credits: null,
      vip_valid_until: null,
    });
  });

  it('maps a fulfilled VIP order snapshot', () => {
    const mapped = toPaymentOrder(
      createOrder({
        product_type: 'vip',
        product_id: 'month',
        amount_cents: 2888,
        credits_amount: 0,
        bonus_credits: 0,
        vip_duration_days: 31,
        vip_bonus_credits: 3000,
        fulfillment_applied: true,
        vip_valid_until: '2026-10-23T00:00:00.000Z',
        credits_added: false,
        status: 'completed',
      })
    );
    expect(mapped.product_type).toBe('vip');
    expect(mapped.product_id).toBe('month');
    expect(mapped.fulfillment_applied).toBe(true);
    expect(mapped.vip_duration_days).toBe(31);
    expect(mapped.vip_bonus_credits).toBe(3000);
    expect(mapped.vip_valid_until).toBe('2026-10-23T00:00:00.000Z');
  });
});

describe('VIP payment settlement', () => {
  function vipOrder(overrides: Partial<MiniappPaymentOrderRow> = {}): MiniappPaymentOrderRow {
    return createOrder({
      id: 'MA-vip-week',
      amount_cents: 1399,
      credits_amount: 0,
      bonus_credits: 0,
      product_type: 'vip',
      product_id: 'week',
      vip_duration_days: 7,
      vip_bonus_credits: 0,
      fulfillment_applied: false,
      credits_added: false,
      ...overrides,
    });
  }

  it.each(['webhook', 'return', 'query', 'cron'] as const)(
    'settles a VIP order through %s without a second fulfillment path',
    async (source) => {
      const order = vipOrder({ id: `MA-vip-${source}` });
      const orders = createOrders(order);
      orders.complete.mockImplementation(async (_id, _txid, settledBy) =>
        vipOrder({
          ...order,
          status: 'completed',
          fulfillment_applied: true,
          credits_added: false,
          settled_by: settledBy,
          vip_valid_until: '2026-09-29T00:00:00.000Z',
        })
      );

      const result = await settlePaidOrder(
        { orderId: order.id, paidAmount: '13.99', providerTransactionId: `tx-${source}` },
        orders,
        createLog(),
        source
      );

      expect(result).toBe('completed');
      expect(orders.complete).toHaveBeenCalledWith(order.id, `tx-${source}`, source);
      expect(checkInviteFirstPaidReward).toHaveBeenCalledWith(
        { userId: order.user_id, orderId: order.id },
        expect.anything()
      );
    }
  );

  it('writes a week notice and still runs the invite hook once', async () => {
    const order = vipOrder();
    const orders = createOrders(order);
    await settlePaidOrder(
      { orderId: order.id, paidAmount: '13.99', providerTransactionId: 'tx-w' },
      orders,
      createLog(),
      'webhook'
    );
    expect(insertUserNotification).toHaveBeenCalledWith({
      userId: order.user_id,
      category: 'system',
      title: 'VIP 周卡已生效',
      body: `订单 ${order.id} 已完成，会员已顺延 7 天。`,
    });
    expect(checkInviteFirstPaidReward).toHaveBeenCalledOnce();
  });

  it('writes a month notice that includes the one-time 3000 bonus', async () => {
    const order = vipOrder({
      id: 'MA-vip-month',
      amount_cents: 2888,
      product_id: 'month',
      vip_duration_days: 31,
      vip_bonus_credits: 3000,
    });
    const orders = createOrders(order);
    await settlePaidOrder(
      { orderId: order.id, paidAmount: '28.88', providerTransactionId: 'tx-m' },
      orders,
      createLog(),
      'return'
    );
    expect(insertUserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'VIP 月卡已生效',
        body: `订单 ${order.id} 已完成，会员已顺延 31 天，3000 专项星尘已到账。`,
      })
    );
  });

  it('keeps the credits notice for a star-dust order', async () => {
    const orders = createOrders();
    await settlePaidOrder(
      { orderId: 'MA-order-1', paidAmount: '6.00', providerTransactionId: 'tx-c' },
      orders,
      createLog(),
      'query'
    );
    expect(insertUserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '星尘充值到账',
        body: '订单 MA-order-1 已完成，600 星尘已到账。',
      })
    );
  });

  it('does not notify again when the same VIP order is confirmed by every source', async () => {
    const order = vipOrder({
      status: 'completed',
      fulfillment_applied: true,
      settled_by: 'webhook',
    });
    const orders = {
      findById: vi.fn(async () => order),
      complete: vi.fn(async () => order),
      reopenExpired: vi.fn(async () => undefined),
    };
    for (const source of ['webhook', 'return', 'query', 'cron'] as const) {
      await settlePaidOrder(
        { orderId: order.id, paidAmount: '13.99', providerTransactionId: 'tx-w' },
        orders,
        createLog(),
        source
      );
    }
    expect(orders.complete).toHaveBeenCalledTimes(4);
    expect(orders.reopenExpired).not.toHaveBeenCalled();
    expect(insertUserNotification).not.toHaveBeenCalled();
    expect(checkInviteFirstPaidReward).toHaveBeenCalledTimes(4);
  });

  it('reopens an expired unpaid VIP order and leaves an already fulfilled one closed', async () => {
    const expired = vipOrder({ status: 'expired' });
    const unpaid = createOrders(expired);
    await settlePaidOrder(
      { orderId: expired.id, paidAmount: '13.99', providerTransactionId: 'tx-late' },
      unpaid,
      createLog(),
      'cron'
    );
    expect(unpaid.reopenExpired).toHaveBeenCalledWith(expired.id);

    const fulfilled = vipOrder({
      status: 'expired',
      fulfillment_applied: true,
      credits_added: false,
    });
    const paid = createOrders(fulfilled);
    await settlePaidOrder(
      { orderId: fulfilled.id, paidAmount: '13.99', providerTransactionId: 'tx-late' },
      paid,
      createLog(),
      'cron'
    );
    expect(paid.reopenExpired).not.toHaveBeenCalled();
    expect(isOrderFulfilled(fulfilled)).toBe(true);
  });

  it('does not fulfill when the paid amount does not match the snapshotted price', async () => {
    const orders = createOrders(vipOrder());
    const result = await settlePaidOrder(
      { orderId: 'MA-vip-week', paidAmount: '13.98', providerTransactionId: 'tx-bad' },
      orders,
      createLog(),
      'webhook'
    );
    expect(result).toBe('amount_mismatch');
    expect(orders.complete).not.toHaveBeenCalled();
    expect(insertUserNotification).not.toHaveBeenCalled();
    expect(checkInviteFirstPaidReward).not.toHaveBeenCalled();
  });

  it('returns failed and skips notice and invite when the database fulfillment errors', async () => {
    const orders = createOrders(vipOrder());
    orders.complete.mockRejectedValueOnce(new Error('db down'));
    const result = await settlePaidOrder(
      { orderId: 'MA-vip-week', paidAmount: '13.99', providerTransactionId: 'tx-w' },
      orders,
      createLog(),
      'webhook'
    );
    expect(result).toBe('failed');
    expect(insertUserNotification).not.toHaveBeenCalled();
    expect(checkInviteFirstPaidReward).not.toHaveBeenCalled();
  });

  it('keeps the VIP fulfillment when the notice write fails', async () => {
    vi.mocked(insertUserNotification).mockRejectedValueOnce(new Error('notify down'));
    const orders = createOrders(vipOrder());
    const result = await settlePaidOrder(
      { orderId: 'MA-vip-week', paidAmount: '13.99', providerTransactionId: 'tx-w' },
      orders,
      createLog(),
      'webhook'
    );
    expect(result).toBe('completed');
    expect(orders.complete).toHaveBeenCalledOnce();
    expect(checkInviteFirstPaidReward).toHaveBeenCalledOnce();
  });
});
