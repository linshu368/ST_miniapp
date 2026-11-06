import { createHmac } from 'crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestLogger } from '../lib/logger.js';
import type { MiniappPaymentOrderRow } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type {
  PaymentQueryResult,
  VexutopiaWebhookEvent,
  WebhookVerification,
} from '../infrastructure/payment/VexutopiaPaymentGateway.js';
import { insertUserNotification } from '../lib/notifications.js';
import { checkInviteFirstPaidReward } from '../lib/invite-rewards.js';
import { handleVexutopiaWebhook } from './payment.js';
import {
  isOrderFulfilled,
  reconcileWithGateway,
  settlePaidOrder,
} from '../features/payment/usecases/PaymentSettlement.js';
import { toPaymentOrder } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';

const WEBHOOK_SECRET = 'whsec_route_test';

vi.mock('../platform/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/config.js')>();
  return {
    config: {
      ...actual.config,
      payment: {
        ...actual.config.payment,
        enabled: true,
        returnUrl: 'https://backend.example/api/payment/return',
        environmentTag: 'test-env',
        vexutopia: {
          baseUrl: 'https://vex.example/api/v1',
          apiKey: 'vex_test_key',
          webhookSecret: 'whsec_route_test',
        },
      },
    },
  };
});

vi.mock('../lib/notifications.js', () => ({
  insertUserNotification: vi.fn(async () => undefined),
}));

vi.mock('../lib/invite-rewards.js', () => ({
  checkInviteFirstPaidReward: vi.fn(async () => undefined),
}));

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
    provider_transaction_id: 'tx_abc123',
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

function createEvent(overrides: Partial<VexutopiaWebhookEvent> = {}): VexutopiaWebhookEvent {
  return {
    event: 'payment.completed',
    id: 'tx_abc123',
    payment_id: 'tx_abc123',
    status: 'completed',
    amount: '6',
    currency: 'CNY',
    payment_method: 'wxpay',
    metadata: { mijing_order_id: 'MA-order-1', mijing_env: 'test-env' },
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

function verifiedGateway(event: VexutopiaWebhookEvent = createEvent()) {
  return {
    environment: 'test-env',
    verifyWebhook: vi.fn((): WebhookVerification => ({ ok: true, event })),
  };
}

function rejectingGateway(reason: Extract<WebhookVerification, { ok: false }>['reason']) {
  return {
    environment: 'test-env',
    verifyWebhook: vi.fn((): WebhookVerification => ({ ok: false, reason })),
  };
}

function createEvents() {
  return { recordOperationEvent: vi.fn(async () => undefined) };
}

async function deliver(
  gateway: ReturnType<typeof verifiedGateway> | ReturnType<typeof rejectingGateway>,
  orders = createOrders(),
  events = createEvents()
) {
  const result = await handleVexutopiaWebhook(Buffer.from('{}'), 't=1,v1=x', {
    gateway,
    orders,
    events,
    log: createLog(),
  });
  // 事件写入是旁路异步的，等一拍再断言。
  await new Promise((resolve) => setImmediate(resolve));
  return { result, orders, events };
}

function recordedClasses(events: ReturnType<typeof createEvents>) {
  return events.recordOperationEvent.mock.calls.map(
    (call) => (call as unknown as [{ event_kind: string; error_class: string | null }])[0]
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleVexutopiaWebhook', () => {
  it('completes a valid order and writes one arrival notification', async () => {
    const { result, orders } = await deliver(verifiedGateway());

    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'tx_abc123', 'webhook');
    expect(insertUserNotification).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 200, body: 'OK' });
  });

  it('runs the invite first-paid reward hook for the credited order', async () => {
    await deliver(verifiedGateway());

    expect(checkInviteFirstPaidReward).toHaveBeenCalledWith(
      { userId: '00000000-0000-0000-0000-000000000001', orderId: 'MA-order-1' },
      expect.anything()
    );
  });

  it('does not notify twice when a completed order receives a repeated callback', async () => {
    const order = createOrder({ status: 'completed', credits_added: true, settled_by: 'webhook' });
    const orders = {
      findById: vi.fn(async () => order),
      complete: vi.fn(async () => order),
      reopenExpired: vi.fn(async () => undefined),
    };

    const { result } = await deliver(verifiedGateway(), orders);

    expect(orders.complete).toHaveBeenCalledOnce();
    expect(orders.reopenExpired).not.toHaveBeenCalled();
    expect(insertUserNotification).not.toHaveBeenCalled();
    // 到账通知不重发，但发奖判定要重跑：判定自带幂等，重放是上一次失败判定唯一的重试机会。
    expect(checkInviteFirstPaidReward).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
  });

  it('asks the provider to retry when local settlement fails', async () => {
    const orders = createOrders();
    orders.complete.mockRejectedValueOnce(new Error('db down'));

    const { result } = await deliver(verifiedGateway(), orders);

    expect(result).toEqual({ status: 500, body: 'retry' });
  });

  it('reopens an order that expired before the callback arrived, then credits it', async () => {
    const { result, orders } = await deliver(
      verifiedGateway(),
      createOrders(createOrder({ status: 'expired' }))
    );

    expect(orders.reopenExpired).toHaveBeenCalledWith('MA-order-1');
    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'tx_abc123', 'webhook');
    expect(insertUserNotification).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
  });

  it('does not reopen an expired order that was already credited', async () => {
    const { orders } = await deliver(
      verifiedGateway(),
      createOrders(createOrder({ status: 'expired', credits_added: true }))
    );

    expect(orders.reopenExpired).not.toHaveBeenCalled();
  });

  it.each([
    ['signature_invalid', 401],
    ['stale_timestamp', 401],
    ['not_configured', 401],
    ['invalid_body', 400],
  ] as const)('rejects an unverified delivery (%s) with %s', async (reason, status) => {
    const { result, orders, events } = await deliver(rejectingGateway(reason));

    expect(orders.findById).not.toHaveBeenCalled();
    expect(result.status).toBe(status);
    expect(recordedClasses(events)).toEqual([
      expect.objectContaining({ event_kind: 'webhook', error_class: reason }),
    ]);
  });

  it('acknowledges events from another environment without touching local orders', async () => {
    const { result, orders, events } = await deliver(
      verifiedGateway(
        createEvent({ metadata: { mijing_order_id: 'MA-order-1', mijing_env: 'production' } })
      )
    );

    expect(result).toEqual({ status: 200, body: 'ignored' });
    expect(orders.findById).not.toHaveBeenCalled();
    expect(recordedClasses(events)).toEqual([
      expect.objectContaining({ error_class: 'foreign_environment' }),
    ]);
  });

  it('acknowledges non-completion events without crediting', async () => {
    const { result, orders } = await deliver(
      verifiedGateway(createEvent({ event: 'payment.failed', status: 'failed' }))
    );

    expect(orders.complete).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it('records refunds for manual follow-up instead of reversing benefits', async () => {
    const { result, orders, events } = await deliver(
      verifiedGateway(createEvent({ event: 'payment.refunded', type: 'refund' }))
    );

    expect(orders.complete).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(recordedClasses(events)).toEqual([
      expect.objectContaining({ event_kind: 'webhook', error_class: 'refund' }),
    ]);
  });

  it('acknowledges a completion without our order id and credits nothing', async () => {
    const { result, orders } = await deliver(
      verifiedGateway(createEvent({ metadata: { mijing_env: 'test-env' } }))
    );

    expect(orders.findById).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  it('refuses a completion whose transaction id does not match the order', async () => {
    const { result, orders, events } = await deliver(
      verifiedGateway(createEvent({ payment_id: 'tx_other', id: 'tx_other' }))
    );

    expect(orders.complete).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(recordedClasses(events)).toEqual([
      expect.objectContaining({ event_kind: 'settlement', error_class: 'provider_ref_mismatch' }),
    ]);
  });

  it('refuses a completion in another currency', async () => {
    const { orders, events } = await deliver(verifiedGateway(createEvent({ currency: 'USD' })));

    expect(orders.complete).not.toHaveBeenCalled();
    expect(recordedClasses(events)).toEqual([
      expect.objectContaining({ event_kind: 'settlement', error_class: 'currency_mismatch' }),
    ]);
  });

  it('refuses an amount mismatch without completing the order', async () => {
    const { result, orders } = await deliver(verifiedGateway(createEvent({ amount: '6.01' })));

    expect(orders.complete).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });
});

describe('reconcileWithGateway', () => {
  function createQueryGateway(result: PaymentQueryResult) {
    return { queryOrder: vi.fn(async () => result) };
  }

  it('credits a pending order once the provider reports it as paid', async () => {
    const orders = createOrders();
    const gateway = createQueryGateway({
      success: true,
      paid: true,
      amount: '6',
      tradeNo: 'tx_abc123',
    });
    const order = toPaymentOrder(createOrder({ id: 'MA-query-paid' }));

    const changed = await reconcileWithGateway(order, gateway, orders, createLog());

    expect(gateway.queryOrder).toHaveBeenCalledWith(order);
    expect(orders.complete).toHaveBeenCalledWith('MA-order-1', 'tx_abc123', 'query');
    expect(changed).toBe(true);
  });

  it('credits an expired order the provider reports as paid', async () => {
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

  it('leaves the order alone when the provider reports it unpaid', async () => {
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
    const gateway = createQueryGateway({ success: true, paid: true, amount: '6.00' });

    const changed = await reconcileWithGateway(
      toPaymentOrder(createOrder({ id: 'MA-query-done', status: 'completed' })),
      gateway,
      createOrders(),
      createLog()
    );

    expect(gateway.queryOrder).not.toHaveBeenCalled();
    expect(changed).toBe(false);
  });

  it('skips an order that never got a provider transaction id', async () => {
    const gateway = createQueryGateway({ success: true, paid: true, amount: '6.00' });
    const events = createEvents();

    const changed = await reconcileWithGateway(
      toPaymentOrder(createOrder({ id: 'MA-query-noref', provider_transaction_id: null })),
      gateway,
      createOrders(),
      createLog(),
      'query',
      events
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(gateway.queryOrder).not.toHaveBeenCalled();
    expect(changed).toBe(false);
    expect(events.recordOperationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'skipped', error_class: 'missing_provider_ref' })
    );
  });

  it('throttles repeated polling of the same order', async () => {
    const gateway = createQueryGateway({ success: true, paid: false });
    const order = toPaymentOrder(createOrder({ id: 'MA-query-throttled' }));

    await reconcileWithGateway(order, gateway, createOrders(), createLog());
    await reconcileWithGateway(order, gateway, createOrders(), createLog());

    expect(gateway.queryOrder).toHaveBeenCalledOnce();
  });

  it('keeps the order pending when the provider amount disagrees', async () => {
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

const routeOrders = {
  findById: vi.fn(async (): Promise<MiniappPaymentOrderRow | null> => createOrder()),
  complete: vi.fn(async () => createOrder({ status: 'completed', credits_added: true })),
  reopenExpired: vi.fn(async () => undefined),
  expirePendingByIdForUser: vi.fn(async () => undefined),
  findByIdForUser: vi.fn(async () => null),
  listByUser: vi.fn(async () => []),
  markFailed: vi.fn(async () => undefined),
  create: vi.fn(async () => createOrder()),
  recordOperationEvent: vi.fn(async () => undefined),
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

async function buildPaymentApp() {
  const { default: paymentRoutes } = await import('./payment.js');
  const app = Fastify({ logger: false });
  await app.register(paymentRoutes);
  await app.ready();
  return app;
}

describe('GET /api/payment/orders', () => {
  it('lists orders without expiring pending rows as a read side effect', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    const app = await buildPaymentApp();

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

// 回调面回归护栏：验签依赖原始字节，必须确认路由真的把未解析的 body 交给了网关。
describe('POST /api/payment/webhook/vexutopia', () => {
  const payload = JSON.stringify(createEvent());
  const sign = (body: string, t: number) =>
    createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');

  it('credits the order for a correctly signed JSON delivery', async () => {
    const app = await buildPaymentApp();
    const t = Math.floor(Date.now() / 1000);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/payment/webhook/vexutopia',
        headers: {
          'content-type': 'application/json',
          'x-vexutopia-signature': `t=${t},v1=${sign(payload, t)}`,
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(routeOrders.complete).toHaveBeenCalledWith('MA-order-1', 'tx_abc123', 'webhook');
    } finally {
      await app.close();
    }
  });

  it('rejects a delivery whose body was re-serialized after signing', async () => {
    const app = await buildPaymentApp();
    const t = Math.floor(Date.now() / 1000);
    const reserialized = JSON.stringify(JSON.parse(payload), null, 2);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/payment/webhook/vexutopia',
        headers: {
          'content-type': 'application/json',
          'x-vexutopia-signature': `t=${t},v1=${sign(payload, t)}`,
        },
        payload: reserialized,
      });

      expect(response.statusCode).toBe(401);
      expect(routeOrders.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not change how other payment routes parse JSON', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    const app = await buildPaymentApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/payment/orders',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ plan_id: '', payment_type: 'alipay' }),
      });
      // 解析成对象才会走到参数校验；若被解析成 Buffer 会是另一个错误路径。
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });
});

describe('GET /api/payment/return', () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 }));

  beforeEach(() => {
    // 回跳会解析 Bot username 并查一次平台单据，别让测试打真实网络。
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries the provider for the returning order and never credits from URL params', async () => {
    const app = await buildPaymentApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/payment/return?order_id=MA-order-1&status=success',
      });

      expect(response.statusCode).toBe(302);
      expect(routeOrders.findById).toHaveBeenCalledWith('MA-order-1');
      expect(fetchMock.mock.calls.map((call) => String((call as unknown[])[0]))).toContain(
        'https://vex.example/api/v1/payments/tx_abc123'
      );
      // 平台响应不是已完成交易，所以不能入账；URL 上的 status=success 不起作用。
      expect(routeOrders.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('still navigates for an unknown or malformed order id', async () => {
    const app = await buildPaymentApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/payment/return?order_id=../../etc',
      });

      expect(response.statusCode).toBe(302);
      expect(routeOrders.findById).not.toHaveBeenCalled();
      expect(routeOrders.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
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
      provider_transaction_id: 'tx_abc123',
      settled_by: 'query',
      product_type: 'credits',
      product_id: null,
      fulfillment_applied: false,
      vip_duration_days: null,
      vip_bonus_credits: null,
      vip_bonus_main_credits: 0,
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
