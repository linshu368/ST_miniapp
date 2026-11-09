import { signEpay } from '../infrastructure/payment/epay-protocol.js';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestLogger } from '../lib/logger.js';
import type { MiniappPaymentOrderRow } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import type { PaymentQueryResult } from '../infrastructure/payment/PaymentGateway.js';
import { insertUserNotification } from '../lib/notifications.js';
import { checkInviteFirstPaidReward } from '../lib/invite-rewards.js';
import { handleEpayNotification } from '../features/payment/usecases/EpayNotification.js';
import { EpayPaymentGateway } from '../infrastructure/payment/EpayPaymentGateway.js';
import { paymentClientIp } from './payment.js';
import { fastifyLoggerOptions } from '../lib/logger.js';
import pino from 'pino';
import {
  isOrderFulfilled,
  reconcileWithGateway,
  settlePaidOrder,
} from '../features/payment/usecases/PaymentSettlement.js';
import { toPaymentOrder } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';

const APP_KEY = 'fixture-app-secret';
const ORDER_ID = 'EP' + 'a'.repeat(30);

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
        notifyUrl: 'https://backend.example/api/payment/notify/ttzf',
        epay: {
          baseUrl: 'https://provider.example/api',
          appId: '1001',
          appKey: 'fixture-app-secret',
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
    attachProviderTransaction: vi.fn(async () => true),
    reopenExpired: vi.fn(async () => undefined),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('payment request privacy and client address', () => {
  it('uses only the validated Railway edge address in deployment and socket IP locally', () => {
    const request = {
      ip: '127.0.0.1',
      headers: { 'x-real-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.1' },
    };
    expect(paymentClientIp(request, true)).toBe('203.0.113.10');
    expect(paymentClientIp(request, false)).toBe('127.0.0.1');
    expect(
      paymentClientIp({ ...request, headers: { 'x-real-ip': '203.0.113.10,198.51.100.1' } }, true)
    ).toBe('');
    expect(paymentClientIp({ ...request, headers: {} }, true)).toBe('');
  });
  it('does not emit callback signatures, query fields or IPs in automatic Fastify logs', async () => {
    const lines: string[] = [];
    const options = fastifyLoggerOptions();
    delete options.transport;
    const logger = pino(
      { ...options, level: 'info' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      }
    );
    const app = Fastify({ loggerInstance: logger });
    app.get('/api/payment/notify/ttzf', () => 'fail');
    try {
      await app.inject(
        '/api/payment/notify/ttzf?sign=fixture-sign&name=private-name&clientip=203.0.113.10'
      );
      const output = lines.join('');
      expect(output).toContain('/api/payment/notify/ttzf');
      for (const value of ['fixture-sign', 'private-name', '203.0.113.10'])
        expect(output).not.toContain(value);
    } finally {
      await app.close();
    }
  });
});

function notification(overrides: Record<string, string> = {}) {
  const fields = {
    pid: '1001',
    trade_no: 'tx_abc123',
    out_trade_no: ORDER_ID,
    type: 'wxpay',
    name: 'fixture',
    money: '6.000',
    trade_status: 'TRADE_SUCCESS',
    param: 'test-env',
    sign_type: 'MD5',
    ...overrides,
  };
  return new URLSearchParams({ ...fields, sign: signEpay(fields, APP_KEY) }).toString();
}

describe('epay settlement and notification', () => {
  async function deliver(query = notification(), order = createOrder({ id: ORDER_ID })) {
    const orders = createOrders(order);
    const result = await handleEpayNotification(query, {
      gateway: new EpayPaymentGateway(),
      orders,
      log: createLog(),
      events: { recordOperationEvent: vi.fn(async () => undefined) },
    });
    return { orders, result };
  }

  it('binds an early callback before completing the order', async () => {
    const { orders, result } = await deliver(
      notification(),
      createOrder({ id: ORDER_ID, provider_transaction_id: null })
    );
    expect(result).toEqual({ status: 200, body: 'success' });
    expect(orders.attachProviderTransaction).toHaveBeenCalledWith(ORDER_ID, 'tx_abc123');
    expect(orders.complete).toHaveBeenCalledWith(ORDER_ID, 'tx_abc123', 'webhook');
    expect(insertUserNotification).toHaveBeenCalledOnce();
    expect(checkInviteFirstPaidReward).toHaveBeenCalledOnce();
  });

  it.each([
    [{ money: '6.001' }, 409],
    [{ money: '6.01' }, 409],
    [{ pid: '1002' }, 401],
    [{ type: 'alipay' }, 409],
    [{ trade_no: 'other' }, 409],
    [{ sign_type: 'SHA256' }, 400],
  ] as const)('rejects mismatched trusted fields %j', async (fields, status) => {
    const { orders, result } = await deliver(notification(fields));
    expect(result.status).toBe(status);
    expect(orders.complete).not.toHaveBeenCalled();
  });

  it.each(['TRADE_PENDING', 'TRADE_REFUND', 'TRADE_ERROR'])(
    'acknowledges %s without crediting',
    async (trade_status) => {
      const { orders, result } = await deliver(notification({ trade_status }));
      expect(result).toEqual({ status: 200, body: 'success' });
      expect(orders.complete).not.toHaveBeenCalled();
    }
  );

  it('ignores another environment without touching local orders', async () => {
    const { orders, result } = await deliver(notification({ param: 'other-environment' }));
    expect(result.body).toBe('success');
    expect(orders.findById).not.toHaveBeenCalled();
  });

  it('reopens a late paid order and acknowledges duplicates without another notice', async () => {
    const late = await deliver(notification(), createOrder({ id: ORDER_ID, status: 'expired' }));
    expect(late.orders.reopenExpired).toHaveBeenCalledWith(ORDER_ID);
    vi.clearAllMocks();
    const duplicate = await deliver(
      notification(),
      createOrder({ id: ORDER_ID, status: 'completed', fulfillment_applied: true })
    );
    expect(duplicate.result.body).toBe('success');
    expect(insertUserNotification).not.toHaveBeenCalled();
  });

  it('requests retry after a database failure', async () => {
    const orders = createOrders(createOrder({ id: ORDER_ID }));
    orders.complete.mockRejectedValueOnce(new Error('db down'));
    expect(
      await handleEpayNotification(notification(), {
        gateway: new EpayPaymentGateway(),
        orders,
        log: createLog(),
      })
    ).toEqual({ status: 500, body: 'fail' });
  });

  it('does not complete when a competing callback has bound a different reference', async () => {
    const orders = createOrders(createOrder({ id: ORDER_ID, provider_transaction_id: null }));
    orders.attachProviderTransaction.mockResolvedValueOnce(false);
    expect(
      await settlePaidOrder(
        { orderId: ORDER_ID, paidAmount: '6.00', providerTransactionId: 'tx_other' },
        orders,
        createLog(),
        'query'
      )
    ).toBe('failed');
    expect(orders.complete).not.toHaveBeenCalled();
  });

  it('recovers a missing create response using merchant ID and throttles polling', async () => {
    const order = createOrder({ id: 'EP' + 'b'.repeat(30), provider_transaction_id: null });
    const orders = createOrders(order);
    const gateway = {
      queryOrder: vi.fn(
        async (): Promise<PaymentQueryResult> => ({
          success: true,
          paid: true,
          amount: '6.00',
          tradeNo: 'tx_abc123',
        })
      ),
    };
    expect(await reconcileWithGateway(toPaymentOrder(order), gateway, orders, createLog())).toBe(
      true
    );
    await reconcileWithGateway(toPaymentOrder(order), gateway, orders, createLog());
    expect(gateway.queryOrder).toHaveBeenCalledOnce();
    expect(orders.complete).toHaveBeenCalledOnce();
  });

  it('never queries an old provider order', async () => {
    const gateway = { queryOrder: vi.fn(async () => ({ success: true, paid: false })) };
    await reconcileWithGateway(toPaymentOrder(createOrder()), gateway, createOrders(), createLog());
    expect(gateway.queryOrder).not.toHaveBeenCalled();
  });
});

const routeOrders = {
  findById: vi.fn(async (): Promise<MiniappPaymentOrderRow | null> => createOrder()),
  complete: vi.fn(async () => createOrder({ status: 'completed', credits_added: true })),
  reopenExpired: vi.fn(async () => undefined),
  attachProviderTransaction: vi.fn(async () => true),
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

describe('GET /api/payment/notify/ttzf', () => {
  it('passes the raw signed query and returns the exact provider acknowledgement', async () => {
    routeOrders.findById.mockResolvedValue(createOrder({ id: ORDER_ID }));
    const app = await buildPaymentApp();
    try {
      const response = await app.inject(`/api/payment/notify/ttzf?${notification()}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('success');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(routeOrders.complete).toHaveBeenCalledWith(ORDER_ID, 'tx_abc123', 'webhook');
    } finally {
      await app.close();
    }
  });
  it.each(['&money=6.00', '&pid=1001'])(
    'rejects repeated fields before database access',
    async (suffix) => {
      const app = await buildPaymentApp();
      try {
        const response = await app.inject(`/api/payment/notify/ttzf?${notification()}${suffix}`);
        expect(response.statusCode).toBe(400);
        expect(routeOrders.findById).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
  it('rejects tampering and removes the old webhook endpoint', async () => {
    const app = await buildPaymentApp();
    try {
      expect(
        (
          await app.inject(
            `/api/payment/notify/ttzf?${notification().replace('money=6.000', 'money=7.000')}`
          )
        ).statusCode
      ).toBe(401);
      expect(
        (await app.inject({ method: 'POST', url: '/api/payment/webhook/vexutopia', payload: {} }))
          .statusCode
      ).toBe(404);
      expect(routeOrders.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

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
    routeOrders.findById.mockResolvedValueOnce(createOrder({ id: ORDER_ID }));
    const app = await buildPaymentApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/payment/return?out_trade_no=${ORDER_ID}&trade_status=TRADE_SUCCESS`,
      });

      expect(response.statusCode).toBe(302);
      expect(routeOrders.findById).toHaveBeenCalledWith(ORDER_ID);
      expect(
        fetchMock.mock.calls.map((call) => String((call as unknown[])[0]).split('?')[0])
      ).toContain('https://provider.example/api/epay/api.php');
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
      attachProviderTransaction: vi.fn(async () => true),
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
