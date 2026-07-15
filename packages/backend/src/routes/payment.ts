import { FastifyInstance, FastifyReply, FastifyBaseLogger } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type {
  CreatePaymentOrderRequest,
  GetPaymentOrderData,
  GetPaymentOrdersData,
  GetPaymentOrdersQuery,
  GetPaymentPlansData,
  PaymentOrderStatus,
  PaymentType,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  getInsufficientCreditsNotice,
  getPaymentPlans,
} from '../features/payment/domain/rechargeRules.js';
import { RechargeUseCase } from '../features/payment/usecases/RechargeUseCase.js';
import {
  JLPaymentGateway,
  type PaymentNotifyData,
} from '../infrastructure/payment/JLPaymentGateway.js';
import {
  MiniappPaymentOrderRepository,
  toPaymentOrder,
} from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { config } from '../platform/config.js';

const PAYMENT_STATUSES: PaymentOrderStatus[] = ['pending', 'completed', 'expired', 'failed'];
const PAYMENT_TYPES: PaymentType[] = [
  // 'alipay', // 支付宝通道暂时停用
  'wxpay',
];

export default async function paymentRoutes(app: FastifyInstance) {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      }
    );
  }

  const recharge = new RechargeUseCase();
  const orders = new MiniappPaymentOrderRepository();
  const gateway = new JLPaymentGateway();

  // @frontend-ready: true
  app.get('/api/payment/plans', async (_request, reply) => {
    const [plans, insufficientCreditsNotice] = await Promise.all([
      getPaymentPlans(),
      getInsufficientCreditsNotice(),
    ]);
    return reply.send(
      ok<GetPaymentPlansData>({
        plans,
        insufficient_credits_notice: insufficientCreditsNotice,
      })
    );
  });

  // @frontend-ready: true
  app.post('/api/payment/orders', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const body = request.body as Partial<CreatePaymentOrderRequest>;
    if (!body.plan_id || !isPaymentType(body.payment_type)) {
      return reply.status(400).send(fail('BAD_REQUEST', 'Invalid payment order request'));
    }

    try {
      const dbUser = await getOrCreateDbUser(request.user);
      const data = await recharge.createOrder({
        userId: dbUser.id,
        planId: body.plan_id,
        paymentType: body.payment_type,
      });
      return reply.send(ok(data));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Create payment order failed';
      request.log.warn({ err: error }, 'Create payment order failed');
      return reply.status(400).send(fail('PAYMENT_CREATE_FAILED', message));
    }
  });

  // @frontend-ready: true
  app.get(
    '/api/payment/orders/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const { id } = request.params as { id: string };
      const dbUser = await getOrCreateDbUser(request.user);
      const order = await recharge.getOrderForUser(id, dbUser.id);

      if (!order) {
        return reply.status(404).send(fail('NOT_FOUND', 'Payment order not found'));
      }

      return reply.send(ok<GetPaymentOrderData>({ order }));
    }
  );

  // @frontend-ready: true
  app.get('/api/payment/orders', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const query = request.query as GetPaymentOrdersQuery;
    const status =
      query.status && PAYMENT_STATUSES.includes(query.status) ? query.status : undefined;
    const limit = clampLimit(query.limit);
    const dbUser = await getOrCreateDbUser(request.user);
    await orders.expirePendingForUser(dbUser.id);
    const rows = await orders.listByUser({
      userId: dbUser.id,
      status,
      cursor: query.cursor,
      limit: limit + 1,
    });

    const visibleRows = rows.slice(0, limit);
    const nextRow = rows.length > limit ? rows[limit] : undefined;

    return reply.send(
      ok<GetPaymentOrdersData>({
        items: visibleRows.map(toPaymentOrder),
        next_cursor: nextRow?.created_at ?? null,
      })
    );
  });

  app.get('/api/payment/return', async (request, reply) => {
    const returnData = normalizeNotifyData(request.query);
    const orderId = isSafePaymentOrderId(returnData.out_trade_no) ? returnData.out_trade_no : null;
    const botUsername = await resolveTelegramBotUsername();

    reply.header('Cache-Control', 'no-store');
    if (botUsername) {
      const startParam = orderId ? `payment_return_${orderId}` : 'payment_return';
      const miniappShortName = resolveMiniappShortName();
      const telegramUrl = new URL(`https://t.me/${botUsername}/${miniappShortName}`);
      telegramUrl.searchParams.set('startapp', startParam);
      return reply.redirect(telegramUrl.toString());
    }

    const fallbackUrl = new URL(
      orderId ? `/profile/recharge/${encodeURIComponent(orderId)}` : '/profile/orders',
      config.frontendUrl
    );
    fallbackUrl.searchParams.set('payment', 'returned');
    return reply.redirect(fallbackUrl.toString());
  });

  app.get('/api/payment/webhook/jlpay', async (request, reply) => {
    return handleJlpayWebhook(request.query, reply, gateway, orders, request.log);
  });

  app.post('/api/payment/webhook/jlpay', async (request, reply) => {
    return handleJlpayWebhook(request.body, reply, gateway, orders, request.log);
  });
}

async function handleJlpayWebhook(
  payload: unknown,
  reply: FastifyReply,
  gateway: JLPaymentGateway,
  orders: MiniappPaymentOrderRepository,
  log: FastifyBaseLogger
) {
  const notifyData = normalizeNotifyData(payload);
  if (!notifyData.out_trade_no || !gateway.verifyNotifySign(notifyData)) {
    log.warn({ orderId: notifyData.out_trade_no }, 'JLPay webhook signature failed');
    return reply.status(400).type('text/plain').send('fail');
  }

  if (notifyData.trade_status !== 'TRADE_SUCCESS') {
    return reply.type('text/plain').send('success');
  }

  const order = await orders.findById(notifyData.out_trade_no);
  if (!order) {
    log.warn({ orderId: notifyData.out_trade_no }, 'JLPay webhook order not found');
    return reply.status(404).type('text/plain').send('fail');
  }

  const paidAmountCents = parseAmountCents(notifyData.money);
  if (paidAmountCents !== order.amount_cents) {
    log.warn(
      { orderId: order.id, expected: order.amount_cents, actual: paidAmountCents },
      'JLPay webhook amount mismatch'
    );
    return reply.status(400).type('text/plain').send('fail');
  }

  try {
    await orders.complete(order.id, notifyData.trade_no ?? null);
    return reply.type('text/plain').send('success');
  } catch (error) {
    log.error({ err: error, orderId: order.id }, 'JLPay webhook complete failed');
    return reply.status(500).type('text/plain').send('fail');
  }
}

function normalizeNotifyData(payload: unknown): PaymentNotifyData {
  if (!payload || typeof payload !== 'object') return {};
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [key, String(value)])
  );
}

function isPaymentType(value: unknown): value is PaymentType {
  return typeof value === 'string' && PAYMENT_TYPES.includes(value as PaymentType);
}

function clampLimit(limit: unknown): number {
  const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : Number(limit);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 50);
}

function parseAmountCents(amount: string | undefined): number {
  if (!amount) return NaN;
  return Math.round(Number.parseFloat(amount) * 100);
}

let telegramBotUsernamePromise: Promise<string | null> | null = null;

function resolveTelegramBotUsername(): Promise<string | null> {
  if (!config.telegramBotToken) return Promise.resolve(null);
  telegramBotUsernamePromise ??= fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/getMe`,
    { signal: AbortSignal.timeout(5_000) }
  )
    .then(
      (response) =>
        response.json() as Promise<{
          ok?: boolean;
          result?: { username?: string };
        }>
    )
    .then((data) => {
      const username = data.ok ? data.result?.username?.replace(/^@/, '') : null;
      return username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null;
    })
    .catch(() => null);
  return telegramBotUsernamePromise;
}

function isSafePaymentOrderId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value));
}

function resolveMiniappShortName(): string {
  const value = (process.env.MINIAPP_SHORT_NAME || 'app').replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'app';
}
